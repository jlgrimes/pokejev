import type { GameBoy } from '../emulator/gameboy.ts';
import type { Controller } from './controller.ts';
import type { GameState } from '../game/state.ts';
import { analyzeBattle, type BattleAnalysis } from '../game/battle.ts';
import { decideBattleAction } from '../jev/battle-agent.ts';
import { planOverworld } from '../jev/overworld-agent.ts';
import { decideBattleByEvaluation, planOverworldByEvaluation } from '../jev/evaluate-agent.ts';
import { screenToPng } from '../emulator/png.ts';
import type { JevConfig } from '../jev/model.ts';
import { addNote, addRecent, type Journal } from '../jev/journal.ts';

export interface TurnOutcome {
  kind: 'battle' | 'overworld' | 'auto';
  reasoning: string;
  action: string;
  detail: string;
  model: string;
  usedFallback: boolean;
  latencyMs: number;
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
    };
  }

  if (state.battle && analysis) {
    if (state.ui.battleMenuOpen) {
      return takeBattleTurn({ controller, config, journal, state, analysis });
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
    };
  }

  return takeOverworldTurn({ gb, controller, config, journal, state });
}

async function takeBattleTurn(params: {
  controller: Controller;
  config: JevConfig;
  journal: Journal;
  state: GameState;
  analysis: BattleAnalysis;
}): Promise<TurnOutcome> {
  const { controller, config, journal, state, analysis } = params;
  const started = Date.now();
  const { decision, usedFallback } =
    config.mode === 'evaluate' && !config.offline
      ? await decideBattleByEvaluation(config, state, analysis, journal)
      : await decideBattleAction(config, state, analysis, journal);
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
  };
}

async function takeOverworldTurn(params: {
  gb: GameBoy;
  controller: Controller;
  config: JevConfig;
  journal: Journal;
  state: GameState;
}): Promise<TurnOutcome> {
  const { gb, controller, config, journal, state } = params;
  const started = Date.now();
  // An evaluation model takes structured state, not pictures, so the
  // screenshot is only built for the generative path that can use it.
  const { plan, usedFallback } =
    config.mode === 'evaluate' && !config.offline
      ? await planOverworldByEvaluation(config, state, journal)
      : await planOverworld(config, state, journal, config.vision ? screenToPng(gb.screen(), 3) : undefined);
  const latencyMs = Date.now() - started;

  for (const input of plan.inputs) {
    controller.press(input.button, input.repeat);
  }

  if (plan.goal && plan.goal !== journal.goal) journal.goal = plan.goal;
  if (plan.noteToSelf) addNote(journal, plan.noteToSelf);

  const pressed = plan.inputs
    .map((input) => (input.repeat > 1 ? `${input.button}x${input.repeat}` : input.button))
    .join(' ');
  addRecent(journal, `${state.world.mapName}: ${pressed} (${plan.observation})`);

  return {
    kind: 'overworld',
    reasoning: plan.observation,
    action: pressed,
    detail: plan.goal,
    model: config.model,
    usedFallback,
    latencyMs,
  };
}
