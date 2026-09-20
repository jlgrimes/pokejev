#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameBoy } from './emulator/gameboy.ts';
import { readGameState } from './game/state.ts';
import { analyzeBattle } from './game/battle.ts';
import { loadConfig, listModels, hasVercelOidc, DEFAULT_MODEL, DEFAULT_BATTLE_MODEL } from './jev/model.ts';
import { loadJournal, emptyJournal, saveJournal } from './jev/journal.ts';
import { JevRunner } from './harness/runner.ts';
import { JevEvents } from './harness/events.ts';
import { startViewer } from './viewer/server.ts';

// Load .env if present; Node does this natively, no dependency needed.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file, that is fine */
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rom: { type: 'string' },
    save: { type: 'string' },
    state: { type: 'string' },
    journal: { type: 'string' },
    model: { type: 'string' },
    'battle-model': { type: 'string' },
    port: { type: 'string', short: 'p' },
    turns: { type: 'string' },
    'no-viewer': { type: 'boolean' },
    'no-vision': { type: 'boolean' },
    offline: { type: 'boolean' },
    fair: { type: 'boolean' },
    paused: { type: 'boolean' },
    fresh: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] ?? 'play';

const ROM_PATH = resolve(values.rom ?? process.env.ROM_PATH ?? 'roms/pokemon_red.gb');
const SAVE_PATH = resolve(values.save ?? process.env.SAVE_PATH ?? 'saves/pokemon_red.sav.json');
const STATE_PATH = resolve(values.state ?? process.env.STATE_PATH ?? 'saves/autosave.state.json');
const JOURNAL_PATH = resolve(values.journal ?? process.env.JOURNAL_PATH ?? 'saves/journal.json');

function usage(): void {
  console.log(`
  jev — an LLM that plays Pokemon Red

  Usage: npm run jev -- <command> [options]

  Commands:
    play       Let Jev play, with a live viewer in your browser (default)
    demo       Same harness with no model calls — heuristics only, no API key needed
    doctor     Check that the ROM, gateway key and models are all in order
    models     List every model the Vercel AI Gateway can route to
    state      Print the current game state read out of RAM and exit

  Options:
    --rom <path>            Pokemon Red ROM (default roms/pokemon_red.gb, or $ROM_PATH)
    --state <path>          Emulator save state to resume from and autosave to
    --save <path>           In-game battery save (SRAM) to load
    --model <id>            Gateway model for overworld play (default ${DEFAULT_MODEL})
    --battle-model <id>     Gateway model for battles (default ${DEFAULT_BATTLE_MODEL})
    --port <n>              Viewer port (default 8080)
    --turns <n>             Stop after N decisions
    --paused                Start paused so you can open the viewer first
    --fresh                 Ignore any saved journal and start Jev's memory over
    --fair                  Hide enemy movesets/stats that a human could not see
    --no-vision             Do not send screenshots, use the text state only
    --no-viewer             Run headless, log to the terminal only
    --offline               Play with built-in heuristics instead of the model

  Examples:
    npm run jev -- play --paused
    npm run jev -- demo --turns 50
    npm run jev -- play --battle-model openai/gpt-5.6-sol --fair
`);
}

async function commandModels(): Promise<void> {
  const models = await listModels();
  const language = models.filter((model) => !model.type || model.type === 'language');
  console.log(`${language.length} language models available through the gateway:\n`);
  for (const model of language) {
    console.log(`  ${model.id.padEnd(44)} ${model.name ?? ''}`);
  }
  console.log(`\nUse one with:  npm run jev -- play --model <id>`);
}

async function commandDoctor(): Promise<void> {
  const checks: [string, boolean, string][] = [];

  const romFound = existsSync(ROM_PATH);
  checks.push(['ROM', romFound, romFound ? ROM_PATH : `missing: ${ROM_PATH}`]);

  const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_KEY);
  checks.push([
    'Gateway credentials',
    hasKey || hasVercelOidc(),
    hasKey ? 'AI_GATEWAY_API_KEY set' : hasVercelOidc() ? 'using Vercel OIDC' : 'not set — see .env.example',
  ]);

  let gatewayOk = false;
  let gatewayNote = '';
  try {
    const models = await listModels();
    gatewayOk = models.length > 0;
    gatewayNote = `${models.length} models reachable`;
    const config = loadConfig();
    for (const [label, id] of [['model', config.model], ['battle model', config.battleModel]] as const) {
      const known = models.some((model) => model.id === id);
      checks.push([`${label} "${id}"`, known, known ? 'available' : 'NOT in the gateway catalog']);
    }
  } catch (error) {
    gatewayNote = (error as Error).message;
  }
  checks.splice(2, 0, ['Gateway reachable', gatewayOk, gatewayNote]);

  if (romFound) {
    try {
      const gb = GameBoy.fromFile(ROM_PATH);
      gb.advance(120);
      checks.push(['Emulator boots', gb.frameCount === 120, `ran ${gb.frameCount} frames`]);
    } catch (error) {
      checks.push(['Emulator boots', false, (error as Error).message]);
    }
  }

  console.log('');
  for (const [label, ok, note] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label.padEnd(34)} ${note}`);
  }
  console.log('');
  if (!checks.every(([, ok]) => ok)) process.exitCode = 1;
}

function commandState(): void {
  const gb = GameBoy.fromFile(ROM_PATH, existsSync(SAVE_PATH) ? SAVE_PATH : undefined);
  if (existsSync(STATE_PATH)) gb.readStateFile(STATE_PATH);
  else gb.advance(600);

  const state = readGameState(gb);
  console.log(JSON.stringify(state, null, 2));
  if (state.battle) {
    console.log('\nBattle analysis:');
    console.log(
      JSON.stringify(analyzeBattle(state.battle, state.world.party), null, 2),
    );
  }
}

async function commandPlay(offline: boolean): Promise<void> {
  const config = loadConfig({
    offline,
    ...(values.model ? { model: values.model } : {}),
    ...(values['battle-model'] ? { battleModel: values['battle-model'] } : {}),
    ...(values['no-vision'] ? { vision: false } : {}),
    ...(values.fair ? { fairPlay: true } : {}),
  });

  const gb = GameBoy.fromFile(ROM_PATH, existsSync(SAVE_PATH) ? SAVE_PATH : undefined);

  if (existsSync(STATE_PATH) && !values.fresh) {
    gb.readStateFile(STATE_PATH);
    console.log(`Resumed from save state ${STATE_PATH} (frame ${gb.frameCount})`);
  } else {
    // Only the boot animations; the play loop drives the title screen and the
    // new-game menus itself, checking the screen after every press.
    gb.advance(400);
  }

  const journal = values.fresh ? emptyJournal() : loadJournal(JOURNAL_PATH);
  const events = new JevEvents();

  const runner = new JevRunner({
    gb,
    config,
    journal,
    journalPath: JOURNAL_PATH,
    autosavePath: STATE_PATH,
    events,
    startPaused: values.paused ?? false,
    ...(values.turns ? { maxTurns: Number(values.turns) } : {}),
  });

  if (!values['no-viewer']) {
    const port = Number(values.port ?? process.env.PORT ?? 8080);
    const viewer = await startViewer(events, runner, port);
    console.log(`\n  Watch Jev play:  \x1b[32m${viewer.url}\x1b[0m\n`);
  }

  // Mirror the interesting events into the terminal too.
  events.on('decision', (decision) => {
    const tag = decision.kind === 'battle' ? '\x1b[35mBATTLE\x1b[0m' : decision.kind === 'auto' ? '\x1b[90mAUTO  \x1b[0m' : '\x1b[36mWORLD \x1b[0m';
    console.log(`${tag} ${decision.action}${decision.detail ? ` — ${decision.detail}` : ''}`);
    if (decision.reasoning) console.log(`       \x1b[90m${decision.reasoning}\x1b[0m`);
  });
  events.on('log', (entry) => {
    if (entry.level !== 'info') console.log(`\x1b[33m[${entry.level}]\x1b[0m ${entry.message}`);
  });

  const shutdown = () => {
    console.log('\nStopping — saving journal and state…');
    runner.stop();
    saveJournal(JOURNAL_PATH, runner.journal);
    try { gb.writeStateFile(STATE_PATH); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    offline
      ? 'Running in offline demo mode (no model calls).'
      : `Jev is playing with ${config.model} (battles: ${config.battleModel}).`,
  );
  await runner.run();
  console.log(`Finished after ${runner.turns} turns.`);
  if (!values['no-viewer']) {
    console.log('The viewer is still running so you can look at the final state — Ctrl-C to exit.');
  }
}

try {
  if (values.help || command === 'help') usage();
  else if (command === 'models') await commandModels();
  else if (command === 'doctor') await commandDoctor();
  else if (command === 'state') commandState();
  else if (command === 'demo') await commandPlay(true);
  else if (command === 'play') await commandPlay(values.offline ?? false);
  else {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n\x1b[31m${(error as Error).message}\x1b[0m\n`);
  process.exitCode = 1;
}
