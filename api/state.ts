import { openSession, saveSession } from './_lib/session.ts';
import { describe, FrameRecorder } from './_lib/engine.ts';
import { json, fail, sessionIdFrom } from './_lib/http.ts';
import { loadConfig } from '../src/jev/model.ts';

export const config = { maxDuration: 60 };

/**
 * Current state of a run, without advancing it.
 *
 * Called when the viewer loads so the page is populated before the first tick.
 */
export default async function handler(request: Request): Promise<Response> {
  try {
    const sessionId = sessionIdFrom(request);
    const jevConfig = loadConfig();
    const { gb, journal, turns, isNew } = await openSession(sessionId);

    // Booting past the intro costs several hundred frames; persist it once so
    // reloading the page does not replay the whole title sequence every time.
    if (isNew) await saveSession(sessionId, gb, journal, turns);

    const recorder = new FrameRecorder();
    return json({
      ...describe(gb, journal, turns, jevConfig),
      isNew,
      frames: recorder.finish(gb),
      models: { overworld: jevConfig.model, battle: jevConfig.battleModel },
    });
  } catch (error) {
    return fail(error);
  }
}
