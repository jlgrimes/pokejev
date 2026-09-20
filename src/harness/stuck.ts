import type { GameState } from '../game/state.ts';
import type { Button } from '../emulator/gameboy.ts';

/**
 * Noticing that nothing is happening.
 *
 * A model will happily answer the same question the same way forever, and
 * nothing downstream can tell the difference between "pressed UP and walked"
 * and "pressed UP into a wall". The only reliable signal is the game itself:
 * if the observable state is byte-for-byte what it was last turn, the last
 * turn achieved nothing.
 *
 * This is deliberately cheap and deliberately loud. The cost of a false
 * positive is one wasted button press; the cost of a false negative is a run
 * that spends six thousand turns on the title screen.
 */

/** Tell the model it is repeating itself. */
export const NUDGE_AFTER = 4;

/** Stop paying for advice that is not working and start trying things. */
export const SHAKE_AFTER = 10;

/**
 * Buttons to try, in order, once we stop trusting the decision.
 *
 * START first because a menu opened by accident swallows every other input,
 * then B to back out of one, then A in case something is waiting, then the
 * directions because the remaining way to be stuck is facing a wall.
 */
const SHAKE_SEQUENCE: Button[] = ['START', 'B', 'A', 'B', 'DOWN', 'LEFT', 'UP', 'RIGHT'];

export interface StuckState {
  /** Fingerprint of the last observed game state. */
  fingerprint: string;
  /** Consecutive turns that have produced no observable change. */
  turns: number;
  /** Consecutive turns spent in the opening, which should be finite. */
  intro?: number;
}

/**
 * Everything a turn is supposed to be able to change.
 *
 * The screen text is the workhorse — it catches menus, text boxes and the
 * title screen. Position and party catch the cases where the screen is
 * identical but the world is not, like walking across an open field.
 */
export function fingerprint(state: GameState): string {
  return [
    state.mode,
    state.world.map,
    state.world.x,
    state.world.y,
    state.world.playerName,
    state.world.party.map((mon) => `${mon.species}:${mon.level}:${mon.hp}`).join(','),
    state.battle ? `${state.battle.enemy.species}:${state.battle.enemy.hp}` : '',
    state.screen.flat,
  ].join('|');
}

/** Fold this turn's state into the running count. Mutates and returns it. */
export function trackStuck(previous: StuckState | undefined, state: GameState): StuckState {
  const current = fingerprint(state);
  const intro = previous?.intro ?? 0;
  if (previous && previous.fingerprint === current) {
    return { fingerprint: current, turns: previous.turns + 1, intro };
  }
  return { fingerprint: current, turns: 0, intro };
}

/**
 * How many turns the opening may take before we stop believing in it.
 *
 * Oak's speech alone is a dozen text boxes and each costs a turn, so this has
 * to be generous. The point is only that it is finite: an intro detector that
 * is wrong presses START at the title screen forever, and because the menu
 * opens and closes, the screen keeps changing and the ordinary stuck check
 * never fires. This is the backstop for that.
 */
export const INTRO_PATIENCE = 200;

/** The button to try on a stuck turn, cycling so it never retries one forever. */
export function shakeButton(turnsStuck: number): Button {
  const offset = Math.max(0, turnsStuck - SHAKE_AFTER);
  return SHAKE_SEQUENCE[offset % SHAKE_SEQUENCE.length]!;
}

/** A line for the model, so it knows the last few turns achieved nothing. */
export function stuckWarning(turnsStuck: number): string | null {
  if (turnsStuck < NUDGE_AFTER) return null;
  return (
    `Nothing has changed on screen for ${turnsStuck} turns — whatever you have been ` +
    `pressing is not working. Try something different: a direction you have not tried, ` +
    `B to back out of a menu, or START.`
  );
}
