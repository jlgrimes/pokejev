import type { GameState } from './state.ts';
import { screenHas } from './screen.ts';
import type { Button } from '../emulator/gameboy.ts';

/**
 * Getting from power-on into the game.
 *
 * None of this is gameplay. The title screen, the NEW GAME menu and the two
 * name pickers have exactly one correct answer each, and asking a model to
 * find them means paying for a decision that can also be got wrong — which is
 * how a run ends up 6000 turns deep on the title screen while its journal
 * still says it is walking to Oak's house.
 *
 * So the intro is driven by code, closed-loop: look at the screen, take the
 * one step that phase needs, look again. `detectIntroPhase` returns null the
 * moment we are actually in the game, and from there Jev decides everything.
 */
export type IntroPhase = 'text' | 'naming' | 'main-menu' | 'title';

/**
 * Which part of the opening we are looking at, or null once the game is ours.
 *
 * Order matters. A waiting text box is checked first because Oak's speech
 * covers most of the intro and is the one phase where the player still has no
 * name — without it, "no name yet" would sit on the title-screen rule pressing
 * START at a text box forever.
 */
export function detectIntroPhase(state: GameState): IntroPhase | null {
  // The name pickers offer NEW NAME plus three presets; take a preset.
  if (screenHas(state.screen, 'NEW NAME')) return 'naming';
  if (state.screen.awaitingInput) {
    // Text boxes only belong to the intro while we are still unnamed.
    return state.world.playerName.trim().length === 0 ? 'text' : null;
  }
  if (screenHas(state.screen, 'NEW GAME')) return 'main-menu';
  // Nothing else to go on: an unnamed player is not in the game yet, whether
  // this is the copyright screen, the Game Freak intro, the title, or the
  // attract demo that the title screen falls into when left alone.
  if (state.world.playerName.trim().length === 0) return 'title';
  return null;
}

/** The buttons that phase needs, in order. */
export function introInputs(phase: IntroPhase): Button[] {
  switch (phase) {
    // DOWN moves off NEW NAME onto the first preset (RED, then BLUE for the
    // rival); A takes it. Typing a name on the grid is many more presses and
    // many more ways to get stuck.
    case 'naming': return ['DOWN', 'A'];
    case 'main-menu': return ['A'];
    case 'text': return ['A'];
    // START skips the Game Freak intro, opens the menu from the title, and
    // backs out of the attract demo. It is the right press for all three.
    case 'title': return ['START'];
  }
}

/** What to show a human while this is happening. */
export function describeIntroPhase(phase: IntroPhase): string {
  switch (phase) {
    case 'naming': return 'choosing a name from the presets';
    case 'main-menu': return 'starting a new game';
    case 'text': return "sitting through Oak's introduction";
    case 'title': return 'getting past the title screen';
  }
}
