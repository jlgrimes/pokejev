import { GameBoy, type Button } from '../../src/emulator/gameboy.ts';
import { screenToPng } from '../../src/emulator/png.ts';
import { readGameState } from '../../src/game/state.ts';
import { buildStateEvent, type StateEvent } from '../../src/harness/events.ts';
import { analyzeIfBattle } from '../../src/harness/turn.ts';
import type { JevConfig } from '../../src/jev/model.ts';
import type { Journal } from '../../src/jev/journal.ts';

/**
 * Frames captured per emulated frame, before the adaptive backoff below.
 *
 * Encoding a screenshot costs more than running the emulator frame that
 * produced it, so this is the single biggest lever on how fast a tick gets
 * through the game. JEV_SPEED multiplies it: at 10 the game plays back ten
 * times faster and spends a fraction of the time drawing it.
 */
const configuredSpeed = () => Math.max(1, Math.min(20, Number(process.env.JEV_SPEED ?? 4)));
/** ~8 seconds of playback. Bounds the response regardless of how long a tick ran. */
const MAX_FRAMES = 240;

/**
 * Records the animation produced by a tick so the browser can play it back.
 *
 * Without this the viewer would only ever see the final still frame of each
 * decision and the game would look like a slideshow. Frames are cheap: a
 * four-colour 160x144 PNG is a couple of KB.
 *
 * A tick now runs many decisions, so the footage can be arbitrarily long.
 * Rather than capture the first N frames and drop the rest — which would show
 * the start of the tick and silently discard everything after — the recorder
 * halves its buffer and doubles its stride whenever it fills. The result
 * always spans the whole tick, just at a coarser sample rate the longer it ran.
 */
export class FrameRecorder {
  #frames: string[] = [];
  #counter = 0;
  #stride: number;

  /** `speed` defaults to JEV_SPEED; pass it explicitly to be independent of it. */
  constructor(speed: number = configuredSpeed()) {
    this.#stride = 2 * Math.max(1, Math.min(20, Math.round(speed)));
  }

  attach(gb: GameBoy): void {
    gb.onFrame = (emulator) => {
      this.#counter++;
      if (this.#counter % this.#stride !== 0) return;
      this.#frames.push(screenToPng(emulator.screen(), 1).toString('base64'));
      if (this.#frames.length >= MAX_FRAMES) {
        this.#frames = this.#frames.filter((_, index) => index % 2 === 0);
        this.#stride *= 2;
      }
    };
  }

  /** How many emulated frames each captured frame now represents. */
  get stride(): number {
    return this.#stride;
  }

  detach(gb: GameBoy): void {
    gb.onFrame = null;
  }

  /** Always ends on the current screen, even if the cap was hit mid-action. */
  finish(gb: GameBoy): string[] {
    this.detach(gb);
    this.#frames.push(screenToPng(gb.screen(), 1).toString('base64'));
    return this.#frames;
  }
}

export interface TickView {
  state: StateEvent;
  journal: { goal: string; notes: string[]; stats: Record<string, number> };
  turns: number;
}

export function describe(gb: GameBoy, journal: Journal, turns: number, config: JevConfig): TickView {
  const state = readGameState(gb);
  return {
    state: buildStateEvent(state, analyzeIfBattle(state, config)),
    journal: {
      goal: journal.goal,
      notes: journal.notes,
      stats: journal.stats as unknown as Record<string, number>,
    },
    turns,
  };
}

const VALID_BUTTONS = new Set<string>(['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT']);

export function isButton(value: unknown): value is Button {
  return typeof value === 'string' && VALID_BUTTONS.has(value);
}
