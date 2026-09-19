import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listZipEntries, isZip } from '../api/_lib/zip.ts';
import { inspectRom } from '../src/game/rom.ts';
import { buildTestRom } from './helpers/test-rom.ts';
import { makeZip, asPokemonRed } from './helpers/make-zip.ts';

type Body = Record<string, any>;
const bodyOf = async (response: Response): Promise<Body> => (await response.json()) as Body;

describe('zip reading', () => {
  test('finds and inflates a deflated entry', () => {
    const rom = buildTestRom();
    const archive = makeZip([
      { name: 'readme.html', data: Buffer.from('<p>hi</p>') },
      { name: 'Pokemon Red.gb', data: rom },
    ]);

    assert.equal(isZip(archive), true);
    const entries = listZipEntries(archive);
    assert.deepEqual(entries.map((e) => e.name), ['readme.html', 'Pokemon Red.gb']);

    const extracted = entries[1]!.read();
    assert.equal(extracted.length, rom.length);
    assert.ok(extracted.equals(rom), 'round-tripped bytes must be identical');
  });

  test('handles stored (uncompressed) entries too', () => {
    const data = Buffer.from('plain bytes');
    const entries = listZipEntries(makeZip([{ name: 'a.txt', data, store: true }]));
    assert.ok(entries[0]!.read().equals(data));
  });

  test('a plain ROM is not mistaken for an archive', () => {
    assert.equal(isZip(buildTestRom()), false);
  });
});

describe('ROM validation', () => {
  test('accepts a Pokemon Red cartridge', () => {
    const info = inspectRom(asPokemonRed(buildTestRom()));
    assert.equal(info.valid, true);
    assert.equal(info.title, 'POKEMON RED');
    assert.equal(info.headerChecksumOk, true);
  });

  test('rejects a different game, because the memory map would misread it', () => {
    const info = inspectRom(buildTestRom()); // titled JEVTEST
    assert.equal(info.valid, false);
    assert.match(info.problems.join(' '), /POKEMON RED/);
  });

  test('rejects something that is not a Game Boy ROM at all', () => {
    const info = inspectRom(Buffer.alloc(2048, 0x41));
    assert.equal(info.valid, false);
    assert.match(info.problems.join(' '), /not a Game Boy ROM/);
  });
});

describe('the upload route', () => {
  let rom: typeof import('../api/rom.ts').default;

  before(async () => {
    process.env.LOCAL_STORAGE_DIR = join(mkdtempSync(join(tmpdir(), 'jev-rom-')), 'storage');
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    delete process.env.VERCEL;
    rom = (await import('../api/rom.ts')).default;
  });

  const post = (data: Buffer) =>
    new Request('https://example.test/api/rom', { method: 'POST', body: new Uint8Array(data) });

  test('reports no ROM before one is installed', async () => {
    const body = await bodyOf(await rom(new Request('https://example.test/api/rom')));
    assert.equal(body.present, false);
  });

  test('accepts a zip and stores the ROM inside it', async () => {
    const archive = makeZip([
      { name: 'readme.html', data: Buffer.from('<p>notes</p>') },
      { name: 'Pokemon Red.gb', data: asPokemonRed(buildTestRom()) },
    ]);
    const body = await bodyOf(await rom(post(archive)));

    assert.equal(body.ok, true);
    assert.equal(body.title, 'POKEMON RED');
    assert.match(body.source, /Pokemon Red\.gb.*zip/);

    const after = await bodyOf(await rom(new Request('https://example.test/api/rom')));
    assert.equal(after.present, true);
    assert.equal(after.size, 0x8000);
  });

  test('accepts a bare .gb file', async () => {
    const response = await rom(post(asPokemonRed(buildTestRom())));
    const body = await bodyOf(response);
    assert.equal(response.status, 200);
    assert.equal(body.source, 'uploaded file');
  });

  test('refuses the wrong game rather than silently misreading it later', async () => {
    const response = await rom(post(buildTestRom()));
    assert.equal(response.status, 400);
    assert.match((await bodyOf(response)).error, /POKEMON RED/);
  });

  test('explains when the archive has no ROM in it', async () => {
    const archive = makeZip([{ name: 'readme.html', data: Buffer.from('nope') }]);
    const response = await rom(post(archive));
    assert.equal(response.status, 400);
    assert.match((await bodyOf(response)).error, /no \.gb file/);
  });

  test('rejects an empty upload', async () => {
    assert.equal((await rom(post(Buffer.alloc(0)))).status, 400);
  });

  test('rejects methods other than GET and POST', async () => {
    const response = await rom(new Request('https://example.test/api/rom', { method: 'DELETE' }));
    assert.equal(response.status, 405);
  });
});
