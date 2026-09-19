import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { startViewer, type ViewerHandle } from '../src/viewer/server.ts';
import { JevEvents } from '../src/harness/events.ts';
import { JevRunner } from '../src/harness/runner.ts';
import { GameBoy, type Button } from '../src/emulator/gameboy.ts';
import { loadConfig } from '../src/jev/model.ts';
import { emptyJournal } from '../src/jev/journal.ts';
import { buildTestRom } from './helpers/test-rom.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Read server-sent events off a live stream until `wanted` types have arrived. */
async function collectEvents(
  url: string,
  wanted: string[],
  timeoutMs = 5000,
): Promise<Map<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${url}/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const found = new Map<string, unknown>();
  let buffer = '';

  try {
    while (found.size < wanted.length) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (type && data && wanted.includes(type)) found.set(type, JSON.parse(data));
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return found;
}

describe('live viewer', () => {
  const handles: ViewerHandle[] = [];
  after(async () => {
    for (const handle of handles) await handle.close();
  });

  const stubControls = () => {
    const calls: string[] = [];
    let paused = false;
    return {
      calls,
      controls: {
        pause: () => { paused = true; calls.push('pause'); },
        resume: () => { paused = false; calls.push('resume'); },
        step: () => calls.push('step'),
        queueInput: (button: Button) => calls.push(`input:${button}`),
        isPaused: () => paused,
      },
    };
  };

  test('serves the viewer page', async () => {
    const events = new JevEvents();
    const handle = await startViewer(events, stubControls().controls, 0);
    handles.push(handle);

    const response = await fetch(handle.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Jev plays Pok/);
    assert.match(html, /EventSource\('\/events'\)/);
  });

  test('streams events to a connected browser', async () => {
    const events = new JevEvents();
    const handle = await startViewer(events, stubControls().controls, 0);
    handles.push(handle);

    const collecting = collectEvents(handle.url, ['decision', 'log']);
    // Give the stream a moment to attach before emitting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.emit('decision', {
      kind: 'battle', reasoning: 'it is super effective', action: 'FIGHT',
      model: 'test/model', usedFallback: false, latencyMs: 12, turn: 1,
    });
    events.log('info', 'hello from the harness');

    const received = await collecting;
    assert.equal((received.get('decision') as { action: string }).action, 'FIGHT');
    assert.equal((received.get('log') as { message: string }).message, 'hello from the harness');
  });

  test('replays the latest state to a browser that joins late', async () => {
    const events = new JevEvents();
    const handle = await startViewer(events, stubControls().controls, 0);
    handles.push(handle);

    // Emitted before anyone is listening.
    events.emit('status', {
      running: true, paused: false, turns: 7,
      goal: 'reach PEWTER CITY', notes: [], stats: {},
    });

    const received = await collectEvents(handle.url, ['status']);
    assert.equal((received.get('status') as { turns: number }).turns, 7);
  });

  test('accepts a key containing characters a URL would mangle', async () => {
    const events = new JevEvents();
    // Hosts generate base64-ish secrets. `+` is the dangerous one: query
    // parsing turns it into a space, so a correct key gets rejected.
    const token = 'ab+cd/ef=gh';
    const handle = await startViewer(events, stubControls().controls, 0, { token });
    handles.push(handle);

    const status = (path: string) => fetch(`${handle.url}${path}`).then((r) => r.status);

    assert.equal(await status(`/?key=${token}`), 200, 'raw + must work');
    assert.equal(await status(`/?key=${encodeURIComponent(token)}`), 200, 'encoded must work');
    assert.equal(await status('/?key=wrong'), 401);
    assert.equal(await status('/'), 401);
    // The health check stays reachable so hosts can probe it.
    assert.equal(await status('/healthz'), 200);
  });

  test('the sign-in page offers somewhere to paste the key', async () => {
    const events = new JevEvents();
    const handle = await startViewer(events, stubControls().controls, 0, { token: 'secret' });
    handles.push(handle);

    const html = await fetch(handle.url).then((r) => r.text());
    assert.match(html, /<form/, 'editing a URL by hand is not an acceptable sign-in');
    assert.match(html, /JEV_ACCESS_TOKEN/, 'should say where to find the key');
  });

  test('control buttons reach the runner', async () => {
    const events = new JevEvents();
    const stub = stubControls();
    const handle = await startViewer(events, stub.controls, 0);
    handles.push(handle);

    const post = (body: unknown) =>
      fetch(`${handle.url}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.json());

    assert.deepEqual(await post({ command: 'pause' }), { ok: true, paused: true });
    await post({ command: 'input', button: 'A' });
    await post({ command: 'step' });
    assert.deepEqual(await post({ command: 'resume' }), { ok: true, paused: false });

    assert.deepEqual(stub.calls, ['pause', 'input:A', 'step', 'resume']);
  });
});

describe('the play loop', () => {
  test('runs offline against a ROM and reports what it did', async () => {
    const gb = new GameBoy();
    gb.loadRom(buildTestRom());
    gb.advance(10);

    const events = new JevEvents();
    const decisions: string[] = [];
    events.on('decision', (decision) => decisions.push(decision.action));

    const runner = new JevRunner({
      gb,
      config: loadConfig({ offline: true, vision: false }),
      journal: emptyJournal(),
      journalPath: join(mkdtempSync(join(tmpdir(), 'jev-')), 'journal.json'),
      events,
      maxTurns: 3,
    });

    await runner.run();

    assert.equal(runner.turns, 3);
    assert.equal(decisions.length, 3);
    // With no model configured every decision comes from the built-in heuristics.
    assert.ok(gb.frameCount > 10, 'the emulator should have advanced');
  });

  test('continues the turn count of a resumed run', async () => {
    const gb = new GameBoy();
    gb.loadRom(buildTestRom());
    // A journal carried over from an earlier session.
    const journal = { ...emptyJournal() };
    journal.stats.turns = 630;

    const runner = new JevRunner({
      gb,
      config: loadConfig({ offline: true, vision: false }),
      journal,
      journalPath: join(mkdtempSync(join(tmpdir(), 'jev-')), 'journal.json'),
      maxTurns: 2,
    });

    assert.equal(runner.turns, 630, 'should start from the saved count, not zero');
    await runner.run();
    // maxTurns limits this session, and the cumulative count moves forward.
    assert.equal(runner.turns, 632);
    assert.equal(runner.journal.stats.turns, 632);
  });

  test('pause and step are honoured', async () => {
    const gb = new GameBoy();
    gb.loadRom(buildTestRom());
    const runner = new JevRunner({
      gb,
      config: loadConfig({ offline: true, vision: false }),
      journal: emptyJournal(),
      journalPath: join(mkdtempSync(join(tmpdir(), 'jev-')), 'journal.json'),
      maxTurns: 2,
      startPaused: true,
    });

    const running = runner.run();
    assert.equal(runner.isPaused(), true);

    // Stepping runs exactly one turn and pauses again.
    runner.step();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(runner.turns, 1);
    assert.equal(runner.isPaused(), true);

    runner.resume();
    await running;
    assert.equal(runner.turns, 2);
  });
});
