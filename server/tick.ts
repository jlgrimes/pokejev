import { openSession, saveSession } from './_lib/session.ts';
import { describe, FrameRecorder } from './_lib/engine.ts';
import { json, fail, sessionIdFrom } from './_lib/http.ts';
import { Controller } from '../src/harness/controller.ts';
import { takeTurn, analyzeIfBattle, type TurnOutcome } from '../src/harness/turn.ts';
import { readGameState } from '../src/game/state.ts';
import { loadConfig } from '../src/jev/model.ts';

/**
 * How long one invocation keeps playing before returning.
 *
 * The function limit is 60s; this leaves room to write the snapshot and send
 * the response. Running many decisions per request is the single biggest
 * speed lever: the Blob read, snapshot decompress, emulator restore, recompress
 * and write are per-*request* costs, so one decision per request pays them
 * every turn. Amortised over a dozen decisions they nearly disappear, and the
 * turns that need no model call at all — advancing text boxes — stop costing a
 * whole network round trip each.
 */
const PLAY_BUDGET_MS = 40_000;

/** Hard cap on decisions per request, so a cheap run cannot balloon the payload. */
const MAX_DECISIONS = 24;

/**
 * Play for a while: as many decisions as fit the budget.
 *
 * The browser calls this repeatedly. Nothing runs while nobody is watching,
 * and the snapshot is written before returning, so a refresh resumes exactly
 * where this left off.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = sessionIdFrom(request);
    const jevConfig = loadConfig({ offline: process.env.JEV_OFFLINE === 'true' });

    const { gb, journal, turns } = await openSession(sessionId);
    const recorder = new FrameRecorder();
    recorder.attach(gb);

    const controller = new Controller(gb);
    const decisions: (TurnOutcome & { turn: number })[] = [];
    const startedAt = Date.now();
    let turn = turns;

    do {
      const state = readGameState(gb);
      const outcome = await takeTurn({
        gb,
        controller,
        config: jevConfig,
        journal,
        state,
        analysis: analyzeIfBattle(state, jevConfig),
      });
      turn++;
      decisions.push({ ...outcome, turn });
    } while (Date.now() - startedAt < PLAY_BUDGET_MS && decisions.length < MAX_DECISIONS);

    const frames = recorder.finish(gb);
    journal.stats.turns = turn;
    const bytes = await saveSession(sessionId, gb, journal, turn);

    return json({
      ...describe(gb, journal, turn, jevConfig),
      decisions,
      // The most recent decision, so older clients and the compact UI still work.
      decision: decisions[decisions.length - 1],
      frames,
      frameStride: recorder.stride,
      elapsedMs: Date.now() - startedAt,
      snapshotBytes: bytes,
    });
  } catch (error) {
    return fail(error);
  }
}
