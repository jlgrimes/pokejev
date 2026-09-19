import { generateObject } from 'ai';
import { z } from 'zod';
import type { GameState } from '../game/state.ts';
import type { BattleAnalysis } from '../game/battle.ts';
import { createJevGateway, providerOptions, type JevConfig } from './model.ts';
import { JEV_IDENTITY, formatBattleBriefing } from './prompts.ts';
import type { Journal } from './journal.ts';

export const BattleDecisionSchema = z.object({
  reasoning: z
    .string()
    .describe('One or two sentences: why this is the right action this turn.'),
  action: z
    .enum(['fight', 'switch', 'item', 'run'])
    .describe('What to do this turn.'),
  moveIndex: z
    .number()
    .int()
    .min(0)
    .max(3)
    .nullable()
    .describe('Which move slot to use when action is "fight". Null otherwise.'),
  partySlot: z
    .number()
    .int()
    .min(0)
    .max(5)
    .nullable()
    .describe('Which party slot to switch to when action is "switch". Null otherwise.'),
  item: z
    .string()
    .nullable()
    .describe('Exact bag item name when action is "item" (e.g. "POTION", "POKE BALL"). Null otherwise.'),
  noteToSelf: z
    .string()
    .nullable()
    .describe('Something worth remembering for later in the run, or null.'),
});

export type BattleDecision = z.infer<typeof BattleDecisionSchema>;

const BATTLE_INSTRUCTIONS = `Pick this turn's action in the battle below.

The damage numbers have already been computed for you with the real Gen 1 formula — trust them
rather than re-deriving them. Your job is judgement:
- If a move is a guaranteed KO, take it. Do not switch or heal when you can simply win.
- If you are in knockout range and cannot KO first, seriously consider switching or healing.
- Prefer super-effective coverage, but a neutral move with higher raw damage can beat a
  resisted "super-effective" one. Compare the actual damage numbers.
- Never pick a move with 0 PP, and never pick one the opponent is immune to.
- In a wild battle you may run if the fight is pointless or dangerous; in a trainer battle you cannot.
- Only throw a ball at a wild Pokemon you actually want, and weaken it first if the odds are poor.

Answer with the structured decision only.`;

/** Deterministic fallback: the highest-scoring legal move. Used if the model call fails. */
export function fallbackBattleDecision(analysis: BattleAnalysis): BattleDecision {
  const usable = analysis.moves.filter((move) => move.pp > 0 && move.effectiveness > 0);
  const best = usable[0] ?? analysis.moves[0];
  return {
    reasoning: best
      ? `Fallback heuristic: ${best.name} has the best expected damage this turn.`
      : 'Fallback heuristic: no usable moves, attacking anyway.',
    action: 'fight',
    moveIndex: best?.index ?? 0,
    partySlot: null,
    item: null,
    noteToSelf: null,
  };
}

/** Ask Jev what to do this turn. */
export async function decideBattleAction(
  config: JevConfig,
  state: GameState,
  analysis: BattleAnalysis,
  journal: Journal,
): Promise<{ decision: BattleDecision; usedFallback: boolean }> {
  if (config.offline) {
    return { decision: fallbackBattleDecision(analysis), usedFallback: true };
  }

  const briefing = formatBattleBriefing(state, analysis, journal, { fairPlay: config.fairPlay });
  const gateway = createJevGateway();

  try {
    const result = await generateObject({
      model: gateway(config.battleModel),
      schema: BattleDecisionSchema,
      system: JEV_IDENTITY,
      prompt: `${BATTLE_INSTRUCTIONS}\n\n${briefing}`,
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      providerOptions: providerOptions(config),
    });
    return { decision: sanitize(result.object, analysis), usedFallback: false };
  } catch (error) {
    console.error(`[jev] battle model call failed, falling back: ${(error as Error).message}`);
    return { decision: fallbackBattleDecision(analysis), usedFallback: true };
  }
}

/**
 * Keep the model honest: a decision that names an illegal move or an empty
 * party slot would strand the harness in a menu, so repair it here.
 */
function sanitize(decision: BattleDecision, analysis: BattleAnalysis): BattleDecision {
  if (decision.action === 'fight') {
    const chosen = analysis.moves.find((move) => move.index === decision.moveIndex);
    if (!chosen || chosen.pp === 0) {
      const fallback = fallbackBattleDecision(analysis);
      return { ...decision, moveIndex: fallback.moveIndex, reasoning: `${decision.reasoning} (adjusted: original move was unusable)` };
    }
  }
  if (decision.action === 'switch') {
    const valid = analysis.switchOptions.some((option) => option.slot === decision.partySlot);
    if (!valid) return fallbackBattleDecision(analysis);
  }
  return decision;
}
