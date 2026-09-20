import {
  experimental_evaluate as evaluate,
  Experimental_EvaluationUnsupportedQuestionTypeError as UnsupportedQuestionType,
} from 'ai';
import type { GameState } from '../game/state.ts';
import type { BattleAnalysis } from '../game/battle.ts';
import { nonEmptyLines } from '../game/screen.ts';
import { BUTTONS, type Button } from '../emulator/gameboy.ts';
import { createJevGateway, providerOptions, type JevConfig } from './model.ts';
import { fallbackBattleDecision, type BattleDecision } from './battle-agent.ts';
import { fallbackButtonPlan, type ButtonPlan } from './overworld-agent.ts';
import { addNote, type Journal } from './journal.ts';

/**
 * Jev as an evaluation model.
 *
 * An evaluation model does not write prose — it judges one shared state
 * against typed questions and returns a chosen option, optionally with a
 * probability distribution. That maps onto playing a game more directly than
 * free-form generation does: the state is the game, and the question is which
 * input to press. There is exactly one legal answer set, so it cannot invent a
 * move that does not exist or a party slot that is empty.
 *
 * The trade-off is that there is no reasoning to display, so the explanation
 * shown in the viewer is reconstructed from the option it picked and how
 * confident it was.
 */

const GEN1_NOTES = [
  'A move is physical or special because of its TYPE, not per move.',
  'Ghost moves do nothing at all to Psychic types.',
  'Psychic is dominant; very little resists it.',
  'Struggle is what you get when every move is out of PP.',
];

/** Turn a probability distribution into something a human can read. */
function explain(
  chosen: string,
  label: (key: string) => string,
  probabilities?: Record<string, number>,
): string {
  if (!probabilities) return `Chose ${label(chosen)}.`;
  const ranked = Object.entries(probabilities)
    .filter(([, p]) => p > 0.01)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const rest = ranked.filter(([key]) => key !== chosen);
  const confidence = probabilities[chosen];
  return (
    `${label(chosen)}${confidence === undefined ? '' : ` at ${pct(confidence)} confidence`}` +
    (rest.length > 0
      ? ` — also weighed ${rest.map(([key, p]) => `${label(key)} ${pct(p)}`).join(', ')}`
      : '')
  );
}

/**
 * How the evaluation model is obtained.
 *
 * Injected rather than imported directly so tests can supply a fake: the
 * gateway is not reachable from a test environment, and the contract worth
 * covering is what gets asked and what is done with the answer.
 */
export interface EvaluateDeps {
  evaluationModel?: (modelId: string) => Parameters<typeof evaluate>[0]['model'];
}

function resolveModel(deps: EvaluateDeps, modelId: string) {
  return deps.evaluationModel
    ? deps.evaluationModel(modelId)
    : createJevGateway().evaluationModel(modelId);
}

// --- battle ----------------------------------------------------------------

/** Everything the model judges against, as structured data rather than prose. */
function battleState(state: GameState, analysis: BattleAnalysis, journal: Journal) {
  const battle = state.battle!;
  return {
    situation: `${battle.kind} battle in Pokemon Red`,
    generation1Rules: GEN1_NOTES,
    yourGoal: journal.goal,
    you: {
      pokemon: battle.player.nickname || battle.player.species,
      level: battle.player.level,
      hp: `${battle.player.hp}/${battle.player.maxHp}`,
      hpPercent: battle.player.hpPercent,
      status: battle.player.status,
      types: battle.player.types.filter((type) => type !== 'UNKNOWN'),
    },
    opponent: {
      pokemon: battle.enemy.species,
      level: battle.enemy.level,
      hpPercent: battle.enemy.hpPercent,
      status: battle.enemy.status,
      types: battle.enemy.types.filter((type) => type !== 'UNKNOWN'),
    },
    whoMovesFirst: analysis.fasterSide,
    youAreInKnockoutRange: analysis.inKoRange,
    turnsYouCanSurvive: Number.isFinite(analysis.turnsToSurvive) ? analysis.turnsToSurvive : null,
    threatsAgainstYou: analysis.incoming.map((threat) => ({
      move: threat.move,
      type: threat.type,
      typicalDamageToYou: threat.damage.typical,
      couldKnockYouOut: threat.canKo,
    })),
    screen: nonEmptyLines(state.screen),
  };
}

/** One option per legal action, described with the numbers already computed. */
function battleCriteria(
  state: GameState,
  analysis: BattleAnalysis,
): Record<string, string> {
  const criteria: Record<string, string> = {};

  for (const move of analysis.moves) {
    if (move.pp === 0) continue; // unusable, so not an option at all
    const outcome = move.guaranteedKo
      ? 'guaranteed knockout'
      : move.possibleKo
        ? 'can knock it out'
        : `${Math.round(move.damage.fractionOfTargetHp * 100)}% of its health`;
    criteria[`move:${move.index}`] =
      `Use ${move.name} (${move.type}). ${move.effectivenessLabel}, about ${move.damage.typical} damage — ${outcome}. ` +
      `${move.accuracy ?? 100}% accurate, ${move.pp} PP left.` +
      (move.notes.length > 0 ? ` Note: ${move.notes.join('; ')}.` : '');
  }

  for (const option of analysis.switchOptions) {
    criteria[`switch:${option.slot}`] =
      `Switch to ${option.name} at ${option.hpPercent}% health — ${option.note}. Costs a turn.`;
  }

  if (state.battle?.kind === 'wild') {
    criteria['run'] = 'Flee the battle, forfeiting any experience.';
  }

  const healing = state.world.bag.find((entry) => /POTION|FULL RESTORE/i.test(entry.item));
  if (healing && state.battle && state.battle.player.hpPercent < 60) {
    criteria[`item:${healing.item}`] = `Use a ${healing.item} to restore health. Costs a turn.`;
  }

  return criteria;
}

export async function decideBattleByEvaluation(
  config: JevConfig,
  state: GameState,
  analysis: BattleAnalysis,
  journal: Journal,
  deps: EvaluateDeps = {},
): Promise<{ decision: BattleDecision; usedFallback: boolean }> {
  const criteria = battleCriteria(state, analysis);
  if (Object.keys(criteria).length === 0) {
    return { decision: fallbackBattleDecision(analysis), usedFallback: true };
  }

  try {
    const result = await evaluate({
      model: resolveModel(deps, config.battleModel),
      state: battleState(state, analysis, journal),
      questions: {
        action: {
          type: 'choice',
          instructions:
            'You are Jev, playing Pokemon Red. Choose this turn\'s action. Take a guaranteed ' +
            'knockout when one is available. If you are in knockout range and cannot win the ' +
            'race, switching or healing is worth the turn. Compare the actual damage numbers ' +
            'rather than trusting type labels alone.',
          criteria,
        },
      },
      ...(providerOptions(config) ? { providerOptions: providerOptions(config) } : {}),
    });

    const answer = result.answers.action;
    return {
      decision: toBattleDecision(answer.choice, analysis, explain(answer.choice, (key) => describeKey(key, analysis), answer.probabilities)),
      usedFallback: false,
    };
  } catch (error) {
    console.error(`[jev] battle evaluation failed, falling back: ${(error as Error).message}`);
    return { decision: fallbackBattleDecision(analysis), usedFallback: true };
  }
}

/** Human-readable name for an option key, for the explanation text. */
function describeKey(key: string, analysis: BattleAnalysis): string {
  if (key.startsWith('move:')) {
    const index = Number(key.slice(5));
    return analysis.moves.find((move) => move.index === index)?.name ?? key;
  }
  if (key.startsWith('switch:')) {
    const slot = Number(key.slice(7));
    return `switch to ${analysis.switchOptions.find((option) => option.slot === slot)?.name ?? slot}`;
  }
  if (key.startsWith('item:')) return `use ${key.slice(5)}`;
  return key;
}

function toBattleDecision(
  choice: string,
  analysis: BattleAnalysis,
  reasoning: string,
): BattleDecision {
  if (choice.startsWith('move:')) {
    const index = Number(choice.slice(5));
    const move = analysis.moves.find((candidate) => candidate.index === index);
    if (move) {
      return { reasoning, action: 'fight', moveIndex: move.index, partySlot: null, item: null, noteToSelf: null };
    }
  }
  if (choice.startsWith('switch:')) {
    const slot = Number(choice.slice(7));
    if (analysis.switchOptions.some((option) => option.slot === slot)) {
      return { reasoning, action: 'switch', moveIndex: null, partySlot: slot, item: null, noteToSelf: null };
    }
  }
  if (choice.startsWith('item:')) {
    return { reasoning, action: 'item', moveIndex: null, partySlot: null, item: choice.slice(5), noteToSelf: null };
  }
  if (choice === 'run') {
    return { reasoning, action: 'run', moveIndex: null, partySlot: null, item: null, noteToSelf: null };
  }
  // The option set is ours, so an unknown answer means something changed.
  return { ...fallbackBattleDecision(analysis), reasoning: `${reasoning} (unrecognised option "${choice}")` };
}

// --- overworld -------------------------------------------------------------

const BUTTON_MEANINGS: Record<Button, string> = {
  UP: 'Walk or face north. In a menu, move the cursor up.',
  DOWN: 'Walk or face south. In a menu, move the cursor down.',
  LEFT: 'Walk or face west. In a menu, move the cursor left.',
  RIGHT: 'Walk or face east. In a menu, move the cursor right.',
  A: 'Confirm, talk, read a sign, or advance a text box.',
  B: 'Cancel, or back out of a menu you did not want.',
  START: 'Open the main menu.',
  SELECT: 'Rarely useful; only for reordering items.',
};

const REPEAT_LEVELS = [1, 2, 4, 8];

function overworldState(state: GameState, journal: Journal) {
  return {
    situation: 'Walking around in Pokemon Red',
    yourGoal: journal.goal,
    location: state.world.mapName,
    position: { x: state.world.x, y: state.world.y },
    badges: state.world.badges,
    money: state.world.money,
    party: state.world.party.map((mon) => ({
      name: mon.nickname || mon.species,
      level: mon.level,
      hpPercent: mon.hpPercent,
      status: mon.status,
    })),
    screenText: nonEmptyLines(state.screen),
    aTextBoxIsWaiting: state.screen.awaitingInput,
    notesToSelf: journal.notes,
    whatYouJustDid: journal.recent,
    hint: 'The first press toward a new direction only turns you; walking there needs another.',
  };
}

export async function planOverworldByEvaluation(
  config: JevConfig,
  state: GameState,
  journal: Journal,
  deps: EvaluateDeps = {},
): Promise<{ plan: ButtonPlan; usedFallback: boolean }> {
  const criteria = Object.fromEntries(
    BUTTONS.map((button) => [button, BUTTON_MEANINGS[button]]),
  ) as Record<string, string>;

  const shared = overworldState(state, journal);
  const buttonQuestion = {
    type: 'choice' as const,
    instructions:
      'You are Jev, playing Pokemon Red. Choose the next button to press, working towards ' +
      'your goal. If a text box is waiting, press A. If you are stuck in a menu you did not ' +
      'want, press B. If you seem to be repeating yourself, try a different direction.',
    criteria,
  };

  try {
    let answers: { button: { choice: string; probabilities?: Record<string, number> }; repeat?: { score: number } };
    try {
      const result = await evaluate({
        model: resolveModel(deps, config.model),
        state: shared,
        questions: {
          button: buttonQuestion,
          repeat: {
            type: 'score' as const,
            instructions:
              'How many times in a row should that button be pressed before looking at the ' +
              'screen again? Prefer fewer when anything uncertain is about to happen.',
            criteria: ['once', 'twice', 'four times', 'eight times'],
          },
        },
        ...(providerOptions(config) ? { providerOptions: providerOptions(config) } : {}),
      });
      answers = result.answers as typeof answers;
    } catch (error) {
      // Not every evaluation model answers score questions; the button alone is enough.
      if (!UnsupportedQuestionType.isInstance(error)) throw error;
      const result = await evaluate({
        model: resolveModel(deps, config.model),
        state: shared,
        questions: { button: buttonQuestion },
        ...(providerOptions(config) ? { providerOptions: providerOptions(config) } : {}),
      });
      answers = result.answers as typeof answers;
    }

    const button = (BUTTONS as readonly string[]).includes(answers.button.choice)
      ? (answers.button.choice as Button)
      : 'A';
    const level = Math.max(0, Math.min(REPEAT_LEVELS.length - 1, Math.round(answers.repeat?.score ?? 0)));

    return {
      plan: {
        observation: explain(answers.button.choice, (key) => key, answers.button.probabilities),
        goal: journal.goal, // an evaluation model returns no prose to restate it with
        inputs: [{ button, repeat: REPEAT_LEVELS[level]! }],
        noteToSelf: null,
      },
      usedFallback: false,
    };
  } catch (error) {
    console.error(`[jev] overworld evaluation failed, falling back: ${(error as Error).message}`);
    return { plan: fallbackButtonPlan(state, journal), usedFallback: true };
  }
}

/** Kept so the journal still records something when evaluation is in use. */
export function rememberEvaluation(journal: Journal, note: string | null): void {
  if (note) addNote(journal, note);
}
