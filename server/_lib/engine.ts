import { GameBoy, type Button } from '../../src/emulator/gameboy.ts';
import { screenToPng } from '../../src/emulator/png.ts';
import { readGameState } from '../../src/game/state.ts';
import { buildStateEvent, type StateEvent } from '../../src/harness/events.ts';
import { analyzeIfBattle } from '../../src/harness/turn.ts';
import type { JevConfig } from '../../src/jev/model.ts';
import type { Journal } from '../../src/jev/journal.ts';

/** Frames are captured every other emulated frame, i.e. 30fps of game time. */
const CAPTURE_EVERY = 2;
/** ~5 seconds of footage. Enough for any single action, bounded for payload size. */
const MAX_FRAMES = 150;

/**
 * Records the animation produced by a tick so the browser can play it back.
 *
 * Without this the viewer would only ever see the final still frame of each
 * decision and the game would look like a slideshow. Frames are cheap: a
 * four-colour 160x144 PNG is a couple of KB.
 */
export class FrameRecorder {
  #frames: string[] = [];
  #counter = 0;

  attach(gb: GameBoy): void {
    gb.onFrame = (emulator) => {
      this.#counter++;
      if (this.#counter % CAPTURE_EVERY !== 0) return;
      if (this.#frames.length >= MAX_FRAMES) return;
      this.#frames.push(screenToPng(emulator.screen(), 1).toString('base64'));
    };
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
