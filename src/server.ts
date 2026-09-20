#!/usr/bin/env -S npx tsx
/**
 * The always-on server: Jev plays continuously, you watch when you feel like it.
 *
 * This is the architecture the harness was built for. One long-lived process
 * holds the Game Boy in memory, so there is no per-turn snapshot round trip at
 * all — the serverless deployment pays that cost on every single request. Play
 * continues whether or not anyone has the page open, and closing the tab stops
 * nothing.
 *
 * It starts even without a ROM, serving a page that asks for one, rather than
 * exiting. A container that exits on a missing file just restart-loops, and
 * needing storage credentials only to hand it a file would make setup harder
 * than it has to be.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GameBoy, type Button } from './emulator/gameboy.ts';
import { JevRunner } from './harness/runner.ts';
import { JevEvents } from './harness/events.ts';
import { startViewer, type ViewerControls } from './viewer/server.ts';
import { loadConfig } from './jev/model.ts';
import { saveJournal, emptyJournal, type Journal } from './jev/journal.ts';
import { getStorage, hasBlobCredentials } from '../server/_lib/storage.ts';
import { ROM_KEY } from '../server/_lib/rom.ts';
import { listZipEntries, isZip } from '../server/_lib/zip.ts';
import { inspectRom } from './game/rom.ts';

try {
  process.loadEnvFile('.env');
} catch {
  /* container environments supply real env vars */
}

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? '.data/server';
// Keep the storage layer's local fallback inside the same directory, so a
// mounted volume holds everything rather than just half of it.
process.env.LOCAL_STORAGE_DIR ??= DATA_DIR;
const STATE_KEY = 'server/autosave.state.json';
const JOURNAL_KEY = 'server/journal.json';
const PERSIST_EVERY = Number(process.env.JEV_PERSIST_EVERY ?? 10);

mkdirSync(DATA_DIR, { recursive: true });

const storage = getStorage();
const localState = join(DATA_DIR, 'autosave.state.json');
const localJournal = join(DATA_DIR, 'journal.json');
const localRom = join(DATA_DIR, 'rom.gb');

console.log(
  hasBlobCredentials()
    ? 'Persisting progress to Blob storage — restarts and redeploys resume the same run.'
    : `No Blob credentials; persisting to ${DATA_DIR}. Mount a volume there so a ` +
        'redeploy resumes instead of starting a new game.',
);

const events = new JevEvents();
let runner: JevRunner | null = null;

// --- the ROM ---------------------------------------------------------------

async function findRom(): Promise<Buffer | null> {
  const configured = process.env.ROM_PATH;
  if (configured && existsSync(configured)) return readFileSync(configured);
  if (existsSync(localRom)) return readFileSync(localRom);
  return await storage.read(ROM_KEY);
}

/** Unwrap a zip if that is what arrived, then check the cartridge header. */
function extractRom(upload: Buffer): { rom: Buffer; source: string } {
  if (!isZip(upload)) return { rom: upload, source: 'uploaded file' };
  const entry = listZipEntries(upload).find((candidate) => /\.gbc?$/i.test(candidate.name));
  if (!entry) throw new Error('That archive contains no .gb file.');
  return { rom: entry.read(), source: `${entry.name} (from the zip)` };
}

async function installRom(upload: Buffer): Promise<{ title: string; size: number; source: string }> {
  if (upload.length === 0) throw new Error('No file was uploaded.');
  const { rom, source } = extractRom(upload);
  const info = inspectRom(rom);
  if (!info.valid) throw new Error(info.problems.join('; '));

  writeFileSync(localRom, rom);
  if (hasBlobCredentials()) {
    await storage.write(ROM_KEY, rom, 'application/octet-stream').catch(() => {});
  }

  events.log('info', `ROM installed: ${info.title}`);
  // Deliberately not awaited: this runs the game for as long as the process
  // lives. It must still be caught — an unhandled rejection takes the whole
  // process down, which the browser only sees as an unparseable proxy error.
  if (!runner) {
    void startPlaying(rom).catch((error: Error) => {
      console.error(`Could not start playing: ${error.stack ?? error.message}`);
      events.log('error', `Could not start playing: ${error.message}`);
    });
  }
  return { title: info.title, size: info.size, source };
}

// --- running ---------------------------------------------------------------

async function persist(gb: GameBoy, journal: Journal): Promise<void> {
  try {
    const snapshot = Buffer.from(JSON.stringify(gb.saveState({ includeRom: false })));
    await storage.write(STATE_KEY, snapshot, 'application/json');
    await storage.write(JOURNAL_KEY, Buffer.from(JSON.stringify(journal)), 'application/json');
  } catch (error) {
    events.log('warn', `Could not persist progress: ${(error as Error).message}`);
  }
}

async function startPlaying(rom: Buffer): Promise<void> {
  const info = inspectRom(rom);
  console.log(`Loaded ${info.title} (${(info.size / 1024 / 1024).toFixed(0)}MB)`);

  const gb = new GameBoy();
  gb.loadRom(rom);

  const savedState =
    (await storage.read(STATE_KEY)) ?? (existsSync(localState) ? readFileSync(localState) : null);
  let journal = emptyJournal();

  if (savedState) {
    gb.loadState(JSON.parse(savedState.toString('utf8')));
    const savedJournal =
      (await storage.read(JOURNAL_KEY)) ?? (existsSync(localJournal) ? readFileSync(localJournal) : null);
    if (savedJournal) journal = { ...emptyJournal(), ...JSON.parse(savedJournal.toString('utf8')) };
    console.log(`Resumed at turn ${journal.stats.turns} (frame ${gb.frameCount})`);
  } else {
    // Fresh cartridge: boot past the copyright screen and the Game Freak intro.
    gb.advance(600);
    for (let i = 0; i < 6; i++) gb.press('START', { hold: 6, release: 30 });
    gb.advance(120);
    console.log('Started a new game');
  }

  runner = new JevRunner({
    gb,
    config: loadConfig({ offline: process.env.JEV_OFFLINE === 'true' }),
    journal,
    journalPath: localJournal,
    autosavePath: localState,
    autosaveEvery: PERSIST_EVERY,
    events,
    startPaused: process.env.JEV_START_PAUSED === 'true',
  });
  runner.setSpeed(Number(process.env.JEV_SPEED ?? 4));

  let lastPersistedTurn = journal.stats.turns;
  events.on('status', (status) => {
    if (status.turns - lastPersistedTurn >= PERSIST_EVERY) {
      lastPersistedTurn = status.turns;
      void persist(gb, runner!.journal);
    }
  });

  installShutdownHandlers(gb);
  await runner.run();
}

function installShutdownHandlers(gb: GameBoy): void {
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal} — saving progress…`);
      runner?.stop();
      if (runner) saveJournal(localJournal, runner.journal);
      try {
        writeFileSync(localState, JSON.stringify(gb.saveState({ includeRom: false })));
      } catch {
        /* best effort */
      }
      void persist(gb, runner?.journal ?? emptyJournal()).finally(() => process.exit(0));
    });
  }
}

// --- viewer ----------------------------------------------------------------

/** Delegates to the runner once there is one; harmless before a ROM arrives. */
const controls: ViewerControls = {
  pause: () => runner?.pause(),
  resume: () => runner?.resume(),
  step: () => runner?.step(),
  queueInput: (button: Button) => runner?.queueInput(button),
  isPaused: () => runner?.isPaused() ?? true,
  setSpeed: (multiplier: number) => runner?.setSpeed(multiplier),
};

const token = process.env.JEV_ACCESS_TOKEN ?? randomBytes(12).toString('base64url');
const viewer = await startViewer(events, controls, PORT, {
  token,
  rom: {
    status: async () => {
      const rom = await findRom();
      return { present: rom !== null, size: rom?.length ?? null };
    },
    install: installRom,
  },
});

console.log(`\n  Watch Jev play:  ${viewer.url}/?key=${token}\n`);
if (!process.env.JEV_ACCESS_TOKEN) {
  console.log('  (generated access key — set JEV_ACCESS_TOKEN to pin it across restarts)\n');
}

events.on('decision', (decision) => {
  const tag = decision.kind === 'battle' ? 'BATTLE' : decision.kind === 'auto' ? 'AUTO  ' : 'WORLD ';
  console.log(`${tag} ${decision.action}${decision.detail ? ` — ${decision.detail}` : ''}`);
});

// Never let a stray rejection kill the server: it takes the viewer down with
// it, and all the browser can report is that the proxy returned something it
// could not parse.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`Unhandled rejection: ${message}`);
  events.log('error', `Unhandled error: ${message.split('\n')[0]}`);
});

const rom = await findRom();
if (rom) {
  await startPlaying(rom).catch((error: Error) => {
    console.error(`Could not start playing: ${error.stack ?? error.message}`);
    events.log('error', `Could not start playing: ${error.message}`);
  });
} else {
  console.log('No ROM yet — open the page and upload one (a .gb, or the .zip it came in).');
}
