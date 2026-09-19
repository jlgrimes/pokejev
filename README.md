# pokejev

**Jev** is an LLM that plays Pokémon Red. It runs a real Game Boy in a headless
emulator, reads the game's memory to know exactly what is happening, routes its
decisions through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway),
and presses the buttons itself — and you can watch it play in your browser.

```
┌─────────────┐   RAM + screen    ┌──────────────┐   structured state  ┌─────────┐
│  Game Boy   │ ────────────────► │   Harness    │ ──────────────────► │   Jev   │
│ (serverboy) │ ◄──────────────── │  controller  │ ◄────────────────── │ gateway │
└─────────────┘   button presses  └──────────────┘   move / buttons    └─────────┘
                                         │
                                         ▼  server-sent events
                                  live viewer in your browser
```

## Watching it play

<!-- The viewer is the point: an LLM playing a game is only debuggable if you can
     see the screen next to the reason it gave for pressing the button. -->

`npm run play` starts a local viewer at **http://localhost:8080** showing:

- the Game Boy screen, streamed at 30fps
- **what Jev is thinking** — every decision with its reasoning, the model that
  made it, and how long it took
- the **battle table**: every move with its real Gen 1 damage estimate, type
  effectiveness, KO flags and PP
- party HP, badges, money, location, and the exact text on screen
- **controls**: pause, step one decision at a time, or take over with the D-pad
  (arrow keys, `Z`/`X` for A/B, Enter for Start, Space to pause)

## Setup

You need Node 22+ and your own legally obtained Pokémon Red ROM. **No ROM is
included and none will be downloaded** — dump your own cartridge.

```bash
npm install
cp .env.example .env          # add your AI_GATEWAY_API_KEY
cp /path/to/your/rom.gb roms/pokemon_red.gb

npm run jev -- doctor         # checks ROM, key, gateway and model ids
npm run play                  # Jev plays; open http://localhost:8080
```

No API key yet? `npm run demo` runs the whole harness and viewer on built-in
heuristics with zero model calls.

## Commands

| Command | What it does |
| --- | --- |
| `npm run play` | Jev plays, with the live viewer |
| `npm run demo` | Same harness, heuristics only, no API key needed |
| `npm run jev -- doctor` | Verify ROM, gateway key, and that your model ids exist |
| `npm run jev -- models` | List every model the gateway can route to |
| `npm run jev -- state` | Dump the current game state read out of RAM as JSON |
| `npm test` | Run the test suite |

Useful flags: `--paused` (start paused so you can open the viewer first),
`--turns 50`, `--fresh` (wipe Jev's memory), `--fair`, `--no-vision`,
`--model <id>`, `--battle-model <id>`, `--port <n>`, `--no-viewer`.

## How Jev sees the game

The harness does **not** ask a vision model to squint at the screen and guess.
It reads Pokémon Red's actual WRAM (`src/game/addresses.ts`), so Jev knows:

- both battlers' species, level, HP, types, stats, status and stat stages
- its own moves with real remaining PP (PP Up bits masked off)
- the party, the bag, badges, money, map id and tile coordinates

It also decodes the **tile map at `0xC3A0` into literal text**. Because Red's
font tiles live at the same indices as its text encoding, the tile map *is* the
text on screen — so reading dialogue and menus is exact rather than an OCR
guess. A screenshot is still sent alongside in the overworld, where the picture
carries information the text does not (doors, paths, where the player is).

## How Jev fights

Battles are where precision pays, so the harness computes the numbers and lets
the model do the judging. Before every battle decision it runs the real Gen 1
damage formula — integer truncation, the 217-255 roll, STAB, stat stages,
burn — for each of Jev's moves, and hands over a briefing like:

```
YOUR MOVES (damage already calculated with the real Gen 1 formula, stat stages and STAB included)
  [1] EMBER (FIRE, power 40, acc 100, 25pp) → ~27 dmg (25-30), 100% of its HP | super-effective; GUARANTEED KO; 10% burn
  [0] SCRATCH (NORMAL, power 40, acc 100, 35pp) → ~8 dmg (7-9), 40% of its HP | neutral
  [2] GROWL (NORMAL, power 0, acc 100, 40pp) → ~0 dmg (0-0), 0% of its HP | status move; lowers Attack

WHAT THE OPPONENT CAN DO TO YOU
  POISON STING (POISON) → ~2 dmg to you (2-3)
  You can survive roughly 15 more turns at that rate.
```

(That is a real briefing for Charmander L10 against a wild Weedle L6, produced
by the test fixture in `test/battle-state.test.ts`.)

The type chart is Gen 1's, quirks included: **Ghost does nothing to Psychic**,
Poison is strong against Bug, and physical/special is decided by type rather
than per move. Catch odds use the original two-roll algorithm, so Jev can tell
whether to throw a ball now or weaken the target first.

Jev returns a structured decision (`fight` / `switch` / `item` / `run`) that is
validated before it is executed: a move that is out of PP or a party slot that
is empty gets repaired rather than mashed into the menus.

## How Jev presses buttons

Every menu interaction is **closed-loop**. The controller presses, re-reads the
screen, and checks the cursor actually landed where it wanted, identifying
entries by the text next to the `▶` cursor rather than by a memorised index.
Open-loop button sequences drift the moment an animation runs a frame long, and
over a ten-hour run that drift is fatal. Red's 2×2 battle menu gets genuine
two-axis navigation, because no single direction reaches the diagonal entry.

Anything that needs no judgement — advancing text boxes, waiting out attack
animations — is handled without a model call at all.

## Configuration

Jev's brain is one env var. Any gateway model works, and battles can use a
different (usually stronger) model than overworld navigation:

```bash
JEV_MODEL=anthropic/claude-sonnet-5
JEV_BATTLE_MODEL=anthropic/claude-opus-5
JEV_FALLBACK_MODELS=openai/gpt-5.6-sol,google/gemini-3.1-pro-preview
```

`--fair` hides what a human could not see (enemy movesets and exact stats),
leaving Jev only the species, level and HP bar. Off by default, because reading
RAM is the whole point of the harness; on, it is a much fairer benchmark.

## State and memory

- `saves/autosave.state.json` — full emulator save state, written every 25 turns
  and on exit. Runs resume from it automatically; `--fresh` starts over.
- `saves/journal.json` — Jev's own memory: current goal, durable notes it writes
  to itself, and a rolling log of recent actions. Without this the agent
  rediscovers its goal every few seconds and walks in circles.

## Layout

```
src/
  emulator/   typed serverboy wrapper: frames, buttons, memory, save states, PNG
  game/       addresses, text codec, state reader, Gen 1 data, battle analysis
  jev/        gateway client, prompts, battle and overworld agents, journal
  harness/    controller, play loop, frame pump, event bus
  viewer/     SSE server and the browser UI
test/         49 tests, including a hand-assembled ROM that tests the emulator
```

## Testing

`npm test` needs no ROM and no API key. `test/helpers/test-rom.ts` hand-assembles
a 32KB Game Boy ROM that writes to the tile map and mirrors the joypad into RAM,
which lets the emulator, input and save-state paths be tested end to end without
a copyrighted game. Battle logic is tested by planting exact situations in fake
RAM and asserting what the analysis makes of them.

## Notes and limitations

- Pokémon Red is not included. Supply your own dump.
- The gateway code path needs network access to `ai-gateway.vercel.sh`; run
  `npm run jev -- doctor` if anything looks wrong.
- The emulator is [serverboy](https://gitlab.com/piglet-plays/serverboy.js)
  (GPL-2.0), a headless fork of GameBoy-Online. It is accurate enough for Red
  but is not a cycle-perfect emulator.
- Long runs drift. The journal, save states and the viewer's step button exist
  so you can see it happen and steer.
