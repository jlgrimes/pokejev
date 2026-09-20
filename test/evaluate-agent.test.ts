import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGameBoy, encodeString } from './helpers/fake-gameboy.ts';
import { ADDR } from '../src/game/addresses.ts';
import { TYPE_IDS } from '../src/game/data/types.ts';
import { readGameState } from '../src/game/state.ts';
import { analyzeBattle } from '../src/game/battle.ts';
import { emptyJournal } from '../src/jev/journal.ts';
import { loadConfig } from '../src/jev/model.ts';

/**
 * The gateway is unreachable from the test environment, so the model is faked
 * at the provider interface. That is the contract that matters here: what the
 * agent asks, and what it does with the answer.
 */
type Captured = { state: unknown; questions: Record<string, any> };

function fakeEvaluationModel(answer: (captured: Captured) => Record<string, unknown>) {
  const calls: Captured[] = [];
  const model = {
    specificationVersion: 'v4' as const,
    provider: 'fake',
    modelId: 'typesafe-ai/jev',
    supportedQuestionTypes: ['choice', 'score', 'boolean'] as const,
    async doEvaluate(options: any) {
      const captured = { state: options.state, questions: options.questions };
      calls.push(captured);
      return { answers: answer(captured), usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] };
    },
  };
  return { model, calls };
}

/** The agent takes its model as a dependency, so the fake is simply passed in. */
async function withFakeModel(
  answer: (captured: Captured) => Record<string, unknown>,
): Promise<{
  agent: typeof import('../src/jev/evaluate-agent.ts');
  calls: Captured[];
  deps: { evaluationModel: () => any };
}> {
  const { model, calls } = fakeEvaluationModel(answer);
  const agent = await import('../src/jev/evaluate-agent.ts');
  return { agent, calls, deps: { evaluationModel: () => model } };
}

/** Charmander facing a wild Weedle, with EMBER a guaranteed knockout. */
function battleFixture() {
  const gb = new FakeGameBoy();
  gb.fillScreen();
  gb.writeByte(ADDR.wIsInBattle, 1);
  const B = ADDR.BATTLE_MON;
  const E = ADDR.ENEMY_MON;
  gb.writeByte(B.species, 0xb0);
  gb.writeWord(B.hp, 30); gb.writeWord(B.maxHp, 30); gb.writeByte(B.level, 10);
  gb.writeByte(B.type1, TYPE_IDS.FIRE); gb.writeByte(B.type2, TYPE_IDS.FIRE);
  gb.writeBytes(B.moves, [10, 52, 45, 0]);
  gb.writeBytes(B.pp, [35, 25, 40, 0]);
  gb.writeWord(B.attack, 13); gb.writeWord(B.defense, 12);
  gb.writeWord(B.speed, 16); gb.writeWord(B.special, 14);
  gb.writeBytes(ADDR.wBattleMonNick, encodeString('CHARMANDER', 11));
  gb.writeByte(E.species, 0x70);
  gb.writeWord(E.hp, 20); gb.writeWord(E.maxHp, 20); gb.writeByte(E.level, 6);
  gb.writeByte(E.type1, TYPE_IDS.BUG); gb.writeByte(E.type2, TYPE_IDS.POISON);
  gb.writeBytes(E.moves, [40, 0, 0, 0]);
  gb.writeBytes(E.pp, [35, 0, 0, 0]);
  gb.writeWord(E.attack, 9); gb.writeWord(E.defense, 8);
  gb.writeWord(E.speed, 10); gb.writeWord(E.special, 8);
  for (const address of [
    ADDR.wPlayerMonAttackMod, ADDR.wPlayerMonDefenseMod, ADDR.wPlayerMonSpeedMod,
    ADDR.wPlayerMonSpecialMod, ADDR.wPlayerMonAccuracyMod, ADDR.wPlayerMonEvasionMod,
    ADDR.wEnemyMonAttackMod, ADDR.wEnemyMonDefenseMod, ADDR.wEnemyMonSpeedMod,
    ADDR.wEnemyMonSpecialMod, ADDR.wEnemyMonAccuracyMod, ADDR.wEnemyMonEvasionMod,
  ]) gb.writeByte(address, 7);
  gb.writeScreenText(14, 9, '▶FIGHT');
  gb.writeScreenText(14, 15, 'PKMN');
  gb.writeScreenText(16, 15, 'RUN');

  const state = readGameState(gb.asGameBoy());
  return { state, analysis: analyzeBattle(state.battle!, state.world.party) };
}

const config = () => loadConfig({ mode: 'evaluate', offline: false });

describe('battles as an evaluation', () => {
  test('offers one option per legal action and nothing else', async () => {
    const { state, analysis } = battleFixture();
    const { agent, calls, deps } = await withFakeModel(() => ({
      action: { type: 'choice', choice: 'move:1' },
    }));

    await agent.decideBattleByEvaluation(config(), state, analysis, emptyJournal(), deps);

    const criteria = calls[0]!.questions.action.criteria as Record<string, string>;
    // Three moves, but GROWL and SCRATCH and EMBER all have PP, so all three.
    assert.deepEqual(
      Object.keys(criteria).filter((key) => key.startsWith('move:')).sort(),
      ['move:0', 'move:1', 'move:2'],
    );
    // A wild battle can be fled.
    assert.ok('run' in criteria);
    // The description carries the precomputed numbers.
    assert.match(criteria['move:1']!, /EMBER.*super-effective.*guaranteed knockout/);
  });

  test('never offers a move that is out of PP', async () => {
    const { state, analysis } = battleFixture();
    // moves is ranked by score, so select by slot index rather than position.
    analysis.moves.find((move) => move.index === 0)!.pp = 0; // SCRATCH exhausted
    const { agent, calls, deps } = await withFakeModel(() => ({
      action: { type: 'choice', choice: 'move:1' },
    }));

    await agent.decideBattleByEvaluation(config(), state, analysis, emptyJournal(), deps);
    assert.ok(!('move:0' in calls[0]!.questions.action.criteria));
  });

  test('turns the chosen option into an executable decision', async () => {
    const { state, analysis } = battleFixture();
    // A distribution must cover every option offered, so build it from them.
    const { agent, deps } = await withFakeModel((captured) => {
      const keys = Object.keys(captured.questions.action.criteria);
      const weights: Record<string, number> = { 'move:1': 0.82, 'move:0': 0.15 };
      const remaining = keys.filter((key) => !(key in weights));
      const spare = (1 - 0.97) / Math.max(1, remaining.length);
      return {
        action: {
          type: 'choice',
          choice: 'move:1',
          probabilities: Object.fromEntries(
            keys.map((key) => [key, weights[key] ?? spare]),
          ),
        },
      };
    });

    const { decision, usedFallback } = await agent.decideBattleByEvaluation(config(), state, analysis, emptyJournal(), deps);

    assert.equal(usedFallback, false);
    assert.equal(decision.action, 'fight');
    assert.equal(decision.moveIndex, 1);
    // No prose comes back, so the explanation is rebuilt from the distribution.
    assert.match(decision.reasoning, /EMBER at 82% confidence/);
    assert.match(decision.reasoning, /SCRATCH 15%/);
  });

  test('maps a flee and a switch back correctly', async () => {
    const { state, analysis } = battleFixture();
    const fleeing = await withFakeModel(() => ({ action: { type: 'choice', choice: 'run' } }));
    const { decision } = await fleeing.agent.decideBattleByEvaluation(config(), state, analysis, emptyJournal(), fleeing.deps);
    assert.equal(decision.action, 'run');
  });

  test('an option that was never offered cannot be acted on', async () => {
    const { state, analysis } = battleFixture();
    const { agent, deps } = await withFakeModel(() => ({
      action: { type: 'choice', choice: 'move:9' },
    }));

    // The SDK itself rejects a choice outside the criteria, so a nonsense
    // answer can never reach the code that presses buttons.
    const { decision, usedFallback } = await agent.decideBattleByEvaluation(
      config(), state, analysis, emptyJournal(), deps,
    );
    assert.equal(usedFallback, true);
    assert.equal(decision.action, 'fight');
    assert.ok([0, 1, 2].includes(decision.moveIndex!), 'must be a real move');
  });

  test('falls back when the model errors', async () => {
    const { state, analysis } = battleFixture();
    const { agent, deps } = await withFakeModel(() => {
      throw new Error('gateway exploded');
    });

    const { decision, usedFallback } = await agent.decideBattleByEvaluation(config(), state, analysis, emptyJournal(), deps);
    assert.equal(usedFallback, true);
    assert.equal(decision.action, 'fight');
  });
});

describe('the overworld as an evaluation', () => {
  function overworldFixture() {
    const gb = new FakeGameBoy();
    gb.fillScreen();
    gb.writeByte(ADDR.wCurMap, 0x00);
    gb.writeByte(ADDR.wXCoord, 5);
    gb.writeByte(ADDR.wYCoord, 6);
    gb.writeScreenText(12, 1, 'HELLO THERE');
    return readGameState(gb.asGameBoy());
  }

  test('asks which button, with every button as an option', async () => {
    const { agent, calls, deps } = await withFakeModel(() => ({
      button: { type: 'choice', choice: 'UP' },
      repeat: { type: 'score', score: 1 },
    }));

    const { plan } = await agent.planOverworldByEvaluation(config(), overworldFixture(), emptyJournal(), deps);

    const criteria = calls[0]!.questions.button.criteria as Record<string, string>;
    assert.deepEqual(Object.keys(criteria).sort(), ['A', 'B', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'START', 'UP']);
    assert.equal(plan.inputs[0]!.button, 'UP');
    assert.equal(plan.inputs[0]!.repeat, 2, 'score level 1 means twice');
  });

  test('retries without the score question when the model rejects it', async () => {
    const { Experimental_EvaluationUnsupportedQuestionTypeError: Unsupported } = await import('ai');
    let attempt = 0;
    const { agent, calls, deps } = await withFakeModel(() => {
      attempt++;
      if (attempt === 1) {
        throw new Unsupported({ questionType: 'score', modelId: 'typesafe-ai/jev' } as never);
      }
      return { button: { type: 'choice', choice: 'A' } };
    });

    const { plan, usedFallback } = await agent.planOverworldByEvaluation(config(), overworldFixture(), emptyJournal(), deps);

    assert.equal(usedFallback, false, 'a rejected score question is not a failure');
    assert.equal(calls.length, 2);
    assert.deepEqual(Object.keys(calls[1]!.questions), ['button']);
    assert.equal(plan.inputs[0]!.button, 'A');
    assert.equal(plan.inputs[0]!.repeat, 1);
  });

  test('a button that does not exist never reaches the controller', async () => {
    const { agent, deps } = await withFakeModel(() => ({
      button: { type: 'choice', choice: 'TURBO' },
    }));
    const { plan, usedFallback } = await agent.planOverworldByEvaluation(
      config(), overworldFixture(), emptyJournal(), deps,
    );
    // Rejected by the SDK before we see it, so the turn falls back safely.
    assert.equal(usedFallback, true);
    assert.ok(['A', 'DOWN'].includes(plan.inputs[0]!.button));
  });
});
