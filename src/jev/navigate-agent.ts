import { experimental_evaluate as evaluate } from 'ai';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { GameState } from '../game/state.ts';
import type { WorldMemory } from '../game/world-map.ts';
import { createJevGateway, providerOptions, type JevConfig } from './model.ts';
import { optionsFor, navigationState, fallbackDestination, type Option } from './destination.ts';
import type { Consideration } from './evaluate-agent.ts';
import { stuckWarning } from '../harness/stuck.ts';
import type { Journal } from './journal.ts';

/**
 * Jev choosing where to go.
 *
 * Both modes answer the same question over the same option set, because the
 * option set is the fix. A generative model picks a key from an enum; an
 * evaluation model weighs the keys and returns a distribution. Neither can
 * name a tile we have already bumped into, because walls are not offered.
 */

const INSTRUCTIONS =
  'You are Jev, playing Pokemon Red. Choose where to go next, working towards your goal. ' +
  'Unexplored ground is how you find doors, items and the next town, so prefer it when you ' +
  'do not know where you are going. Take a known exit when your goal is somewhere else. ' +
  'Press A when something in front of you is worth talking to or reading.';

export interface NavigateDeps {
  evaluationModel?: (modelId: string) => Parameters<typeof evaluate>[0]['model'];
}

export interface NavigateResult {
  option: Option;
  reasoning: string;
  usedFallback: boolean;
  considered?: Consideration[];
}

export async function chooseDestination(
  config: JevConfig,
  state: GameState,
  world: WorldMemory,
  journal: Journal,
  deps: NavigateDeps = {},
): Promise<NavigateResult> {
  const options = optionsFor(state, world, journal);
  const fallback = () => fallbackDestination(options);

  if (config.offline) {
    const option = fallback();
    return { option, reasoning: `Offline: ${option.description}`, usedFallback: true };
  }

  const shared = navigationState(state, world, journal);
  const warning = stuckWarning(journal.stuck?.turns ?? 0);
  const judged = warning ? { warning, ...shared } : shared;

  try {
    if (config.mode === 'evaluate') {
      const criteria = Object.fromEntries(
        options.map((option) => [option.key, option.description]),
      );
      const result = await evaluate({
        model: deps.evaluationModel
          ? deps.evaluationModel(config.model)
          : createJevGateway().evaluationModel(config.model),
        state: judged,
        questions: { destination: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
        ...(providerOptions(config) ? { providerOptions: providerOptions(config) } : {}),
      });
      const answer = result.answers.destination;
      const option = options.find((candidate) => candidate.key === answer.choice);
      if (!option) return { option: fallback(), reasoning: 'Unrecognised destination.', usedFallback: true };
      return {
        option,
        reasoning: option.description,
        usedFallback: false,
        considered: weigh(options, answer.choice, answer.probabilities),
      };
    }

    const { object } = await generateObject({
      model: createJevGateway()(config.model),
      schema: z.object({
        reasoning: z.string().describe('One sentence: why there.'),
        destination: z
          .enum(options.map((option) => option.key) as [string, ...string[]])
          .describe('The place to head for.'),
      }),
      system: INSTRUCTIONS,
      prompt:
        `${JSON.stringify(judged, null, 2)}\n\nWhere to:\n` +
        options.map((option) => `  ${option.key}: ${option.description}`).join('\n'),
      ...(providerOptions(config) ? { providerOptions: providerOptions(config) } : {}),
    });
    const option = options.find((candidate) => candidate.key === object.destination);
    if (!option) return { option: fallback(), reasoning: 'Unrecognised destination.', usedFallback: true };
    return { option, reasoning: object.reasoning, usedFallback: false };
  } catch (error) {
    console.error(`[jev] navigation failed, exploring instead: ${(error as Error).message}`);
    const option = fallback();
    return { option, reasoning: `Model call failed; ${option.description}`, usedFallback: true };
  }
}

function weigh(
  options: Option[],
  chosen: string,
  probabilities?: Record<string, number>,
): Consideration[] {
  return options
    .map((option) => ({
      key: option.key,
      label: shortLabel(option),
      probability: probabilities?.[option.key] ?? null,
      chosen: option.key === chosen,
    }))
    .sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1));
}

/** A bar chart needs a few words, not a sentence. */
function shortLabel(option: Option): string {
  const destination = option.destination;
  switch (destination.kind) {
    case 'explore': return `explore ${destination.bearing}`;
    case 'exit': return `exit → ${destination.toName}`;
    case 'interact': return 'press A';
    case 'menu': return 'menu';
    case 'back': return 'back';
  }
}
