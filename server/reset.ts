import { deleteSession, openSession, saveSession } from './_lib/session.ts';
import { describe, FrameRecorder } from './_lib/engine.ts';
import { json, fail, sessionIdFrom } from './_lib/http.ts';
import { loadConfig } from '../src/jev/model.ts';

/** Throw the run away and boot a fresh game, wiping Jev's memory with it. */
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = sessionIdFrom(request);
    await deleteSession(sessionId);

    const jevConfig = loadConfig();
    const { gb, journal, turns } = await openSession(sessionId);
    const recorder = new FrameRecorder();
    await saveSession(sessionId, gb, journal, turns);

    return json({ ...describe(gb, journal, turns, jevConfig), frames: recorder.finish(gb) });
  } catch (error) {
    return fail(error);
  }
}
