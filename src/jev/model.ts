import { createGateway } from '@ai-sdk/gateway';

/**
 * Jev's connection to the Vercel AI Gateway.
 *
 * Everything routes through one gateway key, so switching Jev's brain between
 * providers is a single env var and needs no code change.
 */
export interface JevConfig {
  /** Model used for overworld navigation and general play. */
  model: string;
  /** Model used for battle decisions — worth spending more on. */
  battleModel: string;
  /** Gateway-level fallbacks, tried in order if the primary is unavailable. */
  fallbacks: string[];
  /** Send a screenshot alongside the structured state in the overworld. */
  vision: boolean;
  /** Hide information a human player could not see (enemy movesets, exact stats). */
  fairPlay: boolean;
  /** Skip the model entirely and play with the built-in heuristics. */
  offline: boolean;
  /**
   * Only sent when explicitly set. Several models (including whatever `jev`
   * routes to) reject it, and the SDK warns on every call when it is supplied
   * anyway.
   */
  temperature: number | undefined;
}

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
export const DEFAULT_BATTLE_MODEL = 'anthropic/claude-opus-5';

export function loadConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  const fallbacks = (process.env.JEV_FALLBACK_MODELS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
    battleModel: process.env.JEV_BATTLE_MODEL ?? process.env.JEV_MODEL ?? DEFAULT_BATTLE_MODEL,
    fallbacks,
    vision: process.env.JEV_VISION !== 'false',
    fairPlay: process.env.JEV_FAIR_PLAY === 'true',
    offline: false,
    temperature: process.env.JEV_TEMPERATURE ? Number(process.env.JEV_TEMPERATURE) : undefined,
    ...overrides,
  };
}

export function getApiKey(): string | null {
  return process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_KEY ?? null;
}

/** True when the gateway can authenticate without an explicit key. */
export function hasVercelOidc(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN);
}

export function createJevGateway() {
  const apiKey = getApiKey();
  if (apiKey) return createGateway({ apiKey });

  // Deployed on Vercel, the gateway authenticates with the deployment's own
  // OIDC token, so no API key has to be copied into the project at all.
  if (hasVercelOidc()) return createGateway({});

  throw new Error(
    'AI_GATEWAY_API_KEY is not set. Create a key at https://vercel.com/dashboard/ai-gateway ' +
      'and put it in .env (see .env.example).',
  );
}

/** Gateway provider options shared by every call, including model fallbacks. */
export function providerOptions(
  config: JevConfig,
): Record<string, Record<string, string[]>> | undefined {
  return config.fallbacks.length > 0 ? { gateway: { models: config.fallbacks } } : undefined;
}

/** List everything the gateway can route to. No auth required for this endpoint. */
export async function listModels(): Promise<
  { id: string; name?: string; owner?: string; type?: string }[]
> {
  const response = await fetch('https://ai-gateway.vercel.sh/v1/models');
  if (!response.ok) throw new Error(`Gateway returned ${response.status} listing models`);
  const body = (await response.json()) as {
    data: { id: string; name?: string; owned_by?: string; type?: string }[];
  };
  return body.data.map((model) => ({
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(model.owned_by ? { owner: model.owned_by } : {}),
    ...(model.type ? { type: model.type } : {}),
  }));
}
