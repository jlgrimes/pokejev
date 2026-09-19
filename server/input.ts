import { openSession, saveSession } from './_lib/session.ts';
import { describe, FrameRecorder, isButton } from './_lib/engine.ts';
import { json, fail, readJson, sessionIdFrom } from './_lib/http.ts';
import { Controller } from '../src/harness/controller.ts';
import { loadConfig } from '../src/jev/model.ts';

/** Take over from Jev: press buttons yourself without spending a model call. */
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = sessionIdFrom(request);
    const body = await readJson<{ buttons?: unknown[]; button?: unknown }>(request);
    const requested = body.buttons ?? (body.button ? [body.button] : []);
    const buttons = requested.filter(isButton).slice(0, 12);

    if (buttons.length === 0) return json({ error: 'No valid buttons given' }, 400);

    const jevConfig = loadConfig();
    const { gb, journal, turns } = await openSession(sessionId);
    const recorder = new FrameRecorder();
    recorder.attach(gb);

    const controller = new Controller(gb);
    for (const button of buttons) controller.press(button);

    const frames = recorder.finish(gb);
    await saveSession(sessionId, gb, journal, turns);

    return json({
      ...describe(gb, journal, turns, jevConfig),
      frames,
      pressed: buttons,
    });
  } catch (error) {
    return fail(error);
  }
}
