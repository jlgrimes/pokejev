import { generateObject } from 'ai';
import { z } from 'zod';
import type { GameState } from '../game/state.ts';
import { BUTTONS } from '../emulator/gameboy.ts';
import { createJevGateway, providerOptions, type JevConfig } from './model.ts';
import { JEV_IDENTITY, formatOverworldBriefing } from './prompts.ts';
import type { Journal } from './journal.ts';

export const ButtonPlanSchema = z.object({
  observation: z
    .string()
    .describe('What is happening on screen right now, in one sentence.'),
  goal: z
    .string()
    .describe('The objective you are working towards. Keep the previous goal unless it is done.'),
  inputs: z
    .array(
      z.object({
        button: z.enum(BUTTONS),
        repeat: z
          .number()
          .int()
          .min(1)
          .max(12)
          .describe('How many times to press it (e.g. walking several tiles).'),
      }),
    )
    .min(1)
    .max(6)
    .describe('The button presses to perform now. Keep it short — you will see the result and can continue.'),
  noteToSelf: z
    .string()
    .nullable()
    .describe('A durable fact worth remembering (a location, a blocked path, an NPC), or null.'),
});

export type ButtonPlan = z.infer<typeof ButtonPlanSchema>;

const OVERWORLD_INSTRUCTIONS = `Decide the next few button presses.

How the game works:
- A advances text and confirms; B cancels and backs out of menus; START opens the main menu.
- The d-pad walks one tile per press. In Gen 1 the first press when facing a new direction
  only turns you, so walking sometimes needs one extra press.
- If a text box is waiting (▼ on screen), press A to continue.
- If you are stuck in a menu you did not want, press B.

Plan only a handful of presses. You will see the resulting screen and can decide again, so
short, verifiable steps beat long speculative routes. If you appear to be repeating yourself
or walking into a wall, try a different direction rather than the same one again.`;

/** Deterministic fallback: advance text if a box is waiting, otherwise nudge forward. */
export function fallbackButtonPlan(state: GameState, journal: Journal): ButtonPlan {
  const inputs: ButtonPlan['inputs'] = state.screen.awaitingInput
    ? [{ button: 'A', repeat: 2 }]
    : [{ button: 'DOWN', repeat: 1 }];
  return {
    observation: 'Fallback: model unavailable, taking a safe default action.',
    goal: journal.goal,
    inputs,
    noteToSelf: null,
  };
}

export async function planOverworld(
  config: JevConfig,
  state: GameState,
  journal: Journal,
  screenshot?: Buffer,
): Promise<{ plan: ButtonPlan; usedFallback: boolean }> {
  if (config.offline) {
    return { plan: fallbackButtonPlan(state, journal), usedFallback: true };
  }

  const briefing = formatOverworldBriefing(state, journal);
  const gateway = createJevGateway();

  const text = `${OVERWORLD_INSTRUCTIONS}\n\n${briefing}`;
  const content = screenshot && config.vision
    ? [
        { type: 'text' as const, text },
        { type: 'text' as const, text: 'Here is the current screen as an image:' },
        // A `file` part with an explicit media type; the `image` part is deprecated.
        { type: 'file' as const, data: screenshot, mediaType: 'image/png' },
      ]
    : [{ type: 'text' as const, text }];

  try {
    const result = await generateObject({
      model: gateway(config.model),
      schema: ButtonPlanSchema,
      system: JEV_IDENTITY,
      messages: [{ role: 'user', content }],
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      providerOptions: providerOptions(config),
    });
    return { plan: result.object, usedFallback: false };
  } catch (error) {
    console.error(`[jev] overworld model call failed, falling back: ${(error as Error).message}`);
    return { plan: fallbackButtonPlan(state, journal), usedFallback: true };
  }
}
