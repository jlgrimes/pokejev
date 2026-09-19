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
 * Progress is still written to durable storage periodically, so a restart or a
 * redeploy resumes where it left off rather than starting a new game.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GameBoy } from './emulator/gameboy.ts';
import { JevRunner } from './harness/runner.ts';
import { JevEvents } from './harness/events.ts';
import { startViewer } from './viewer/server.ts';
import { loadConfig } from './jev/model.ts';
import { loadJournal, saveJournal, emptyJournal, type Journal } from './jev/journal.ts';
import { getStorage, hasBlobCredentials } from '../server/_lib/storage.ts';
import { ROM_KEY } from '../server/_lib/rom.ts';
import { inspectRom } from './game/rom.ts';

try {
  process.loadEnvFile('.env');
} catch {
  /* container environments supply real env vars */
}

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? '.data/server';
const STATE_KEY = 'server/autosave.state.json';
const JOURNAL_KEY = 'server/journal.json';
/** Persist to durable storage this often, in turns. */
const PERSIST_EVERY = Number(process.env.JEV_PERSIST_EVERY ?? 10);

mkdirSync(DATA_DIR, { recursive: true });

const storage = getStorage();
const durable = hasBlobCredentials();

console.log(
  durable
    ? 'Persisting progress to Blob storage — restarts and redeploys resume the same run.'
    : `No Blob credentials; persisting to ${DATA_DIR}. Without a mounted volume a ` +
        'redeploy will start a new game. Set BLOB_READ_WRITE_TOKEN to make it durable.',
);

// --- the ROM ---------------------------------------------------------------
async function resolveRom(): Promise<Buffer> {
  const localPath = process.env.ROM_PATH;
  if (localPath && existsSync(localPath)) return readFileSync(localPath);

  const stored = await storage.read(ROM_KEY);
  if (stored) return stored;

  throw new Error(
    `No ROM available. Either set ROM_PATH, or upload one to "${ROM_KEY}" in the Blob ` +
      'store this server is pointed at (the Vercel deployment\'s upload page does that).',
  );
}

const rom = await resolveRom();
const romInfo = inspectRom(rom);
if (!romInfo.valid) throw new Error(romInfo.problems.join('; '));
console.log(`Loaded ${romInfo.title} (${(romInfo.size / 1024 / 1024).toFixed(0)}MB)`);

// --- restore the run -------------------------------------------------------
const gb = new GameBoy();
gb.loadRom(rom);

const localState = join(DATA_DIR, 'autosave.state.json');
const localJournal = join(DATA_DIR, 'journal.json');

const savedState = (await storage.read(STATE_KEY)) ?? (existsSync(localState) ? readFileSync(localState) : null);
let journal: Journal = emptyJournal();

if (savedState) {
  gb.loadState(JSON.parse(savedState.toString('utf8')));
  const savedJournal = (await storage.read(JOURNAL_KEY)) ?? (existsSync(localJournal) ? readFileSync(localJournal) : null);
  if (savedJournal) journal = { ...emptyJournal(), ...JSON.parse(savedJournal.toString('utf8')) };
  console.log(`Resumed at turn ${journal.stats.turns} (frame ${gb.frameCount})`);
} else {
  // Fresh cartridge: boot past the copyright screen and the Game Freak intro.
  gb.advance(600);
  for (let i = 0; i < 6; i++) gb.press('START', { hold: 6, release: 30 });
  gb.advance(120);
  journal = loadJournal(localJournal);
  console.log('Started a new game');
}

// --- run -------------------------------------------------------------------
const events = new JevEvents();
const runner = new JevRunner({
  gb,
  config: loadConfig({ offline: process.env.JEV_OFFLINE === 'true' }),
  journal,
  journalPath: localJournal,
  autosavePath: localState,
  autosaveEvery: PERSIST_EVERY,
  events,
  startPaused: process.env.JEV_START_PAUSED === 'true',
});

/** Mirror the runner's local autosave into durable storage. */
async function persist(): Promise<void> {
  try {
    const snapshot = Buffer.from(JSON.stringify(gb.saveState({ includeRom: false })));
    await storage.write(STATE_KEY, snapshot, 'application/json');
    await storage.write(JOURNAL_KEY, Buffer.from(JSON.stringify(runner.journal)), 'application/json');
  } catch (error) {
    events.log('warn', `Could not persist progress: ${(error as Error).message}`);
  }
}

let lastPersistedTurn = 0;
events.on('status', (status) => {
  if (status.turns - lastPersistedTurn >= PERSIST_EVERY) {
    lastPersistedTurn = status.turns;
    void persist();
  }
});

const token = process.env.JEV_ACCESS_TOKEN ?? randomBytes(12).toString('base64url');
const viewer = await startViewer(events, runner, PORT, { token });

console.log(`\n  Watch Jev play:  ${viewer.url}/?key=${token}\n`);
if (!process.env.JEV_ACCESS_TOKEN) {
  console.log('  (generated access key — set JEV_ACCESS_TOKEN to pin it across restarts)\n');
}

events.on('decision', (decision) => {
  const tag = decision.kind === 'battle' ? 'BATTLE' : decision.kind === 'auto' ? 'AUTO  ' : 'WORLD ';
  console.log(`${tag} ${decision.action}${decision.detail ? ` — ${decision.detail}` : ''}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — saving progress…`);
    runner.stop();
    saveJournal(localJournal, runner.journal);
    try {
      writeFileSync(localState, JSON.stringify(gb.saveState({ includeRom: false })));
    } catch { /* best effort */ }
    void persist().finally(() => process.exit(0));
  });
}

await runner.run();
