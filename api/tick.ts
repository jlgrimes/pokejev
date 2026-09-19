import { openSession, saveSession } from './_lib/session.ts';
import { describe, FrameRecorder } from './_lib/engine.ts';
import { json, fail, sessionIdFrom } from './_lib/http.ts';
import { Controller } from '../src/harness/controller.ts';
import { takeTurn, analyzeIfBattle } from '../src/harness/turn.ts';
import { readGameState } from '../src/game/state.ts';
import { loadConfig } from '../src/jev/model.ts';

export const config = { maxDuration: 60 };

/**
 * Run exactly one Jev decision.
 *
 * The whole loop for one turn: rebuild the Game Boy from storage, read the
 * game, ask Jev (or the heuristics) what to do, press the buttons, then write
 * the machine back. The browser calls this repeatedly to make Jev play, which
 * means nothing runs — and nothing costs anything — while nobody is watching.
 */
export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);

  try {
    const sessionId = sessionIdFrom(request);
    const jevConfig = loadConfig({
      offline: process.env.JEV_OFFLINE === 'true',
    });

    const { gb, journal, turns } = await openSession(sessionId);
    const recorder = new FrameRecorder();
    recorder.attach(gb);

    const state = readGameState(gb);
    const outcome = await takeTurn({
      gb,
      controller: new Controller(gb),
      config: jevConfig,
      journal,
      state,
      analysis: analyzeIfBattle(state, jevConfig),
    });

    const frames = recorder.finish(gb);
    const nextTurn = turns + 1;
    journal.stats.turns = nextTurn;
    const bytes = await saveSession(sessionId, gb, journal, nextTurn);

    return json({
      ...describe(gb, journal, nextTurn, jevConfig),
      decision: { ...outcome, turn: nextTurn },
      frames,
      snapshotBytes: bytes,
    });
  } catch (error) {
    return fail(error);
  }
}
