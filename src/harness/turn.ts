import type { GameBoy } from '../emulator/gameboy.ts';
import type { Controller } from './controller.ts';
import { readGameState, type GameState } from '../game/state.ts';
import { analyzeBattle, type BattleAnalysis } from '../game/battle.ts';
import { decideBattleAction } from '../jev/battle-agent.ts';
import { chooseDestination } from '../jev/navigate-agent.ts';
import { describeDestination } from '../jev/destination.ts';
import { followRoute } from './navigator.ts';
import { emptyWorld, type WorldMemory } from '../game/world-map.ts';
import { decideBattleByEvaluation, type Consideration } from '../jev/evaluate-agent.ts';
import { detectIntroPhase, introInputs, describeIntroPhase } from '../game/intro.ts';
import { trackStuck, shakeButton, SHAKE_AFTER, INTRO_PATIENCE } from './stuck.ts';
import type { JevConfig } from '../jev/model.ts';
import { addNote, addRecent, type Journal } from '../jev/journal.ts';

export interface TurnOutcome {
  kind: 'battle' | 'overworld' | 'auto' | 'intro' | 'stuck';
  reasoning: string;
  action: string;
  detail: string;
  model: string;
  usedFallback: boolean;
  latencyMs: number;
  /**
   * The options Jev weighed, when it was asked as an evaluation model.
   * Absent in generate mode, which returns prose instead of a distribution.
   */
  considered?: Consideration[];
  /** Consecutive turns that have changed nothing. 0 when the game is moving. */
  stuckFor: number;
}

/** Battle analysis for the current state, or null when we are not in a battle. */
export function analyzeIfBattle(state: GameState, config: JevConfig): BattleAnalysis | null {
  if (!state.battle) return null;
  return analyzeBattle(state.battle, state.world.party, { fairPlay: config.fairPlay });
}

/**
 * One decision and the button presses that carry it out.
 *
 * Shared by the local runner and the serverless tick endpoint so that Jev
 * plays identically whether it is running on your laptop or on Vercel. It
 * mutates `journal` (goal, notes, recent actions, stats), which is the memory
 * both callers persist afterwards.
 */
export async function takeTurn(params: {
  gb: GameBoy;
  controller: Controller;
  config: JevConfig;
  journal: Journal;
  state: GameState;
  analysis: BattleAnalysis | null;
}): Promise<TurnOutcome> {
  const { gb, controller, config, journal, state, analysis } = params;
  // The map of where Jev has walked lives in the journal, so it is persisted
  // and restored by exactly the same machinery as everything else it knows.
  const world = (journal.world ??= emptyWorld());

  // Has anything actually happened since last turn? Everything below needs to
  // know, and a turn that is never asked cannot notice it is going nowhere.
  journal.stuck = trackStuck(journal.stuck, state);
  const stuckFor = journal.stuck.turns;

  // The opening is mechanics, not judgement: title screen, NEW GAME, and the
  // two name pickers each have one right answer. Driving them in code is what
  // keeps a run from sitting on the title screen forever while its goal still
  // reads "get out of the house".
  const introPhase = detectIntroPhase(state);
  // An intro that never ends is a detector that is wrong, and it would never
  // trip the check above: pressing START at the title screen opens and closes
  // the menu, so the screen keeps changing while nothing progresses.
  const introExhausted = (journal.stuck.intro ?? 0) > INTRO_PATIENCE;
  journal.stuck.intro = introPhase ? (journal.stuck.intro ?? 0) + 1 : 0;

  if (introPhase && !introExhausted) {
    const buttons = introInputs(introPhase);
    for (const button of buttons) controller.press(button);
    return {
      kind: 'intro',
      reasoning: `Not in the game yet: ${describeIntroPhase(introPhase)}.`,
      action: buttons.join(' '),
      detail: introPhase,
      model: '(none)',
      usedFallback: false,
      latencyMs: 0,
      stuckFor,
    };
  }

  // Either the decision is demonstrably not working, or the opening has run
  // far past any plausible length. Stop paying for advice and try things.
  if (stuckFor >= SHAKE_AFTER || introExhausted) {
    const button = shakeButton(introExhausted ? journal.stuck.intro ?? 0 : stuckFor);
    controller.press(button);
    const why = introExhausted
      ? `the opening has run for ${journal.stuck.intro} turns without ending`
      : `nothing has changed for ${stuckFor} turns`;
    addRecent(journal, `stuck: ${why}, tried ${button}`);
    return {
      kind: 'stuck',
      reasoning: `Giving up on the current approach — ${why}. Trying ${button} instead.`,
      action: button,
      detail: why,
      model: '(none)',
      usedFallback: true,
      latencyMs: 0,
      stuckFor,
    };
  }

  // Text boxes and animations need no judgement, so they cost no model call.
  if (state.screen.awaitingInput && !state.ui.battleMenuOpen) {
    const presses = controller.advanceText(6);
    return {
      kind: 'auto',
      reasoning: 'A text box was waiting; advancing it does not need a decision.',
      action: `press A x${presses || 1}`,
      detail: '',
      model: '(none)',
      usedFallback: false,
      latencyMs: 0,
      stuckFor,
    };
  }

  if (state.battle && analysis) {
    if (state.ui.battleMenuOpen) {
      return takeBattleTurn({ controller, config, journal, state, analysis, stuckFor });
    }
    // Mid-battle animation or message: wait for the menu to come back.
    controller.waitFor((screen) => screen.awaitingInput || screen.flat.includes('FIGHT'), 180);
    return {
      kind: 'auto',
      reasoning: 'The battle is mid-animation; waiting for the menu.',
      action: 'wait',
      detail: '',
      model: '(none)',
      usedFallback: false,
      latencyMs: 0,
      stuckFor,
    };
  }

  return takeOverworldTurn({ gb, controller, config, journal, state, world, stuckFor });
}

async function takeBattleTurn(params: {
  controller: Controller;
  config: JevConfig;
  journal: Journal;
  state: GameState;
  analysis: BattleAnalysis;
  stuckFor: number;
}): Promise<TurnOutcome> {
  const { controller, config, journal, state, analysis, stuckFor } = params;
  const started = Date.now();
  const { decision, usedFallback, considered } =
    config.mode === 'evaluate' && !config.offline
      ? await decideBattleByEvaluation(config, state, analysis, journal)
      : { ...(await decideBattleAction(config, state, analysis, journal)), considered: undefined };
  const latencyMs = Date.now() - started;

  let detail = '';
  let executed = false;

  if (decision.action === 'fight') {
    const move = analysis.moves.find((m) => m.index === decision.moveIndex) ?? analysis.moves[0];
    if (move) {
      detail = `${move.name} (~${move.damage.typical} dmg, ${move.effectivenessLabel})`;
      executed = controller.useMove(move.name);
      journal.stats.movesChosen++;
    }
  } else if (decision.action === 'switch' && decision.partySlot !== null) {
    const target = analysis.switchOptions.find((option) => option.slot === decision.partySlot);
    if (target) {
      detail = `switch to ${target.name}`;
      executed = controller.switchTo(target.name);
    }
  } else if (decision.action === 'item' && decision.item) {
    detail = `use ${decision.item}`;
    executed = controller.useItem(decision.item);
    if (executed && /BALL/i.test(decision.item)) journal.stats.pokemonCaught++;
  } else if (decision.action === 'run') {
    detail = 'flee';
    executed = controller.run();
  }

  // The menu path failed (item missing, switch refused): attack rather than
  // leave the game sitting in a half-open menu.
  if (!executed && decision.action !== 'fight') {
    const best = analysis.moves.find((move) => move.pp > 0);
    if (best) {
      detail += ` → fell back to ${best.name}`;
      controller.useMove(best.name);
    }
  }

  addRecent(journal, `battle: ${decision.action} ${detail}`);
  if (decision.noteToSelf) addNote(journal, decision.noteToSelf);

  // Let the turn play out: our move, theirs, and anything that faints.
  controller.advanceText(10);

  return {
    kind: 'battle',
    reasoning: decision.reasoning,
    action: decision.action.toUpperCase(),
    detail,
    model: config.battleModel,
    usedFallback,
    latencyMs,
    stuckFor,
    ...(considered ? { considered } : {}),
  };
}

async function takeOverworldTurn(params: {
  gb: GameBoy;
  controller: Controller;
  config: JevConfig;
  journal: Journal;
  state: GameState;
  world: WorldMemory;
  stuckFor: number;
}): Promise<TurnOutcome> {
  const { gb, controller, config, journal, state, world, stuckFor } = params;
  const started = Date.now();

  // Jev picks a place, not a button. Every option carries a route that was
  // planned over ground we have walked, so "into the fence" is not on offer.
  const { option, reasoning, usedFallback, considered } =
    await chooseDestination(config, state, world, journal);
  const latencyMs = Date.now() - started;

  const destination = option.destination;
  let action = describeDestination(destination);
  let detail = journal.goal;

  if (destination.kind === 'interact') {
    controller.press('A');
  } else if (destination.kind === 'menu') {
    controller.press('START');
  } else if (destination.kind === 'back') {
    controller.press('B');
  } else {
    const report = followRoute(gb, controller, world, destination.route);
    detail = `${report.taken}/${report.planned} steps`;
    if (report.changedMap) {
      const now = readGameState(gb);
      detail += ` → ${now.world.mapName}`;
      addNote(journal, `${state.world.mapName} (${destination.x},${destination.y}) leads to ${now.world.mapName}`);
    } else if (report.blockedAt) {
      // The one press it takes to learn this is the whole point: the tile is
      // now a wall in the map, so nothing will route through it again.
      detail += ` → blocked going ${report.blockedAt}, remembered`;
      action += ' (hit a wall)';
    }
  }

  addRecent(journal, `${state.world.mapName}: ${action} — ${detail}`);

  return {
    kind: 'overworld',
    reasoning,
    action,
    detail,
    model: config.model,
    usedFallback,
    latencyMs,
    stuckFor,
    ...(considered ? { considered } : {}),
  };
}
