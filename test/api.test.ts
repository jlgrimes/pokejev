import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestRom } from './helpers/test-rom.ts';

/**
 * Exercises the deployed shape of the harness end to end.
 *
 * Each handler call stands in for a separate serverless invocation: nothing is
 * shared between them except what went through storage, which is exactly the
 * property the Vercel deployment depends on.
 */
const workDir = mkdtempSync(join(tmpdir(), 'jev-api-'));
const romPath = join(workDir, 'test.gb');

let state: typeof import('../api/state.ts').default;
let tick: typeof import('../api/tick.ts').default;
let input: typeof import('../api/input.ts').default;
let reset: typeof import('../api/reset.ts').default;

before(async () => {
  writeFileSync(romPath, buildTestRom());
  // Set before importing: storage and ROM paths are read at module load.
  process.env.ROM_PATH = romPath;
  process.env.LOCAL_STORAGE_DIR = join(workDir, 'storage');
  process.env.JEV_OFFLINE = 'true';
  process.env.JEV_VISION = 'false';
  delete process.env.BLOB_READ_WRITE_TOKEN;

  state = (await import('../api/state.ts')).default;
  tick = (await import('../api/tick.ts')).default;
  input = (await import('../api/input.ts')).default;
  reset = (await import('../api/reset.ts')).default;
});

const url = (path: string, session = 'apitest') =>
  `https://example.test/api/${path}?session=${session}`;

/** Handler responses are plain JSON; the tests assert on their shape directly. */
type Body = Record<string, any>;
const bodyOf = async (response: Response): Promise<Body> => (await response.json()) as Body;

const post = (path: string, body?: unknown, session?: string) =>
  new Request(url(path, session), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe('deployed API', () => {
  test('boots a fresh game on first request', async () => {
    const response = await state(new Request(url('state', 'boot')));
    const body = await bodyOf(response);

    assert.equal(response.status, 200);
    assert.equal(body.isNew, true);
    assert.ok(body.frames.length > 0, 'should return at least the current frame');
    assert.ok(body.state, 'should include game state');
    assert.equal(body.turns, 0);
  });

  test('a tick runs one decision and returns the animation', async () => {
    const response = await tick(post('tick'));
    const body = await bodyOf(response);

    assert.equal(response.status, 200);
    assert.equal(body.turns, 1);
    assert.equal(body.decision.turn, 1);
    assert.ok(body.decision.action, 'the decision should name an action');
    assert.ok(body.frames.length > 1, 'a tick should produce several frames');
    // Frames are base64 PNGs.
    assert.equal(Buffer.from(body.frames[0], 'base64').subarray(1, 4).toString('ascii'), 'PNG');
  });

  test('state survives between independent invocations', async () => {
    const first = await bodyOf(await tick(post('tick')));
    const second = await bodyOf(await tick(post('tick')));

    // Nothing is shared in memory between handler calls: the only way the turn
    // counter advances is through the persisted snapshot.
    assert.equal(second.turns, first.turns + 1);

    const observed = await bodyOf(await state(new Request(url('state'))));
    assert.equal(observed.turns, second.turns);
    assert.equal(observed.isNew, false);
  });

  test('the emulator actually advances across invocations', async () => {
    const before = await bodyOf(await state(new Request(url('state', 'advance'))));
    await tick(post('tick', undefined, 'advance'));
    const after = await bodyOf(await state(new Request(url('state', 'advance'))));

    assert.ok(
      after.state.frame > before.state.frame,
      `frame counter should advance (${before.state.frame} → ${after.state.frame})`,
    );
  });

  test('snapshots stay small enough to move per request', async () => {
    const body = await bodyOf(await tick(post('tick', undefined, 'size')));
    assert.ok(body.snapshotBytes > 0);
    assert.ok(
      body.snapshotBytes < 2_000_000,
      `snapshot should stay well under a megabyte, got ${body.snapshotBytes}`,
    );
  });

  test('manual input presses buttons without a decision', async () => {
    const response = await input(post('input', { button: 'A' }, 'manual'));
    const body = await bodyOf(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body.pressed, ['A']);
    assert.ok(body.frames.length > 0);
    assert.equal(body.decision, undefined, 'manual input must not cost a model call');
  });

  test('rejects unknown buttons instead of pressing something random', async () => {
    const response = await input(post('input', { button: 'TURBO' }, 'manual'));
    assert.equal(response.status, 400);
  });

  test('rejects GET on mutating routes', async () => {
    assert.equal((await tick(new Request(url('tick')))).status, 405);
    assert.equal((await input(new Request(url('input')))).status, 405);
  });

  test('reset throws the run away', async () => {
    await tick(post('tick', undefined, 'resettable'));
    const wiped = await bodyOf(await reset(post('reset', undefined, 'resettable')));

    assert.equal(wiped.turns, 0);
    assert.equal(wiped.journal.stats.turns, 0);
  });

  test('sessions are isolated from each other', async () => {
    await tick(post('tick', undefined, 'alice'));
    await tick(post('tick', undefined, 'alice'));
    const bob = await bodyOf(await state(new Request(url('state', 'bob'))));

    assert.equal(bob.turns, 0, "bob's run should be untouched by alice's");
  });

  test('a bad session id falls back to the default rather than escaping storage', async () => {
    const response = await state(new Request('https://example.test/api/state?session=../../etc'));
    assert.equal(response.status, 200);
  });
});
