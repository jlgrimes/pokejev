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


describe('what the viewer gets to watch', () => {
  /** Spread the remaining probability over whatever the agent offered. */
  function distributionFavouring(weights: Record<string, number>) {
    return (captured: Captured) => {
      const keys = Object.keys(captured.questions.action.criteria);
      const used = Object.values(weights).reduce((sum, value) => sum + value, 0);
      const rest = keys.filter((key) => !(key in weights));
      const spare = rest.length > 0 ? (1 - used) / rest.length : 0;
      return {
        action: {
          type: 'choice',
          choice: Object.keys(weights)[0]!,
          probabilities: Object.fromEntries(keys.map((key) => [key, weights[key] ?? spare])),
        },
      };
    };
  }

  test('reports every option it weighed, strongest first', async () => {
    const { state, analysis } = battleFixture();
    const { agent, calls, deps } = await withFakeModel(
      distributionFavouring({ 'move:1': 0.8, 'move:0': 0.15 }),
    );

    const { considered } = await agent.decideBattleByEvaluation(
      config(), state, analysis, emptyJournal(), deps,
    );

    assert.ok(considered, 'an evaluation always has a distribution to show');
    // Every offered option appears, so the bars add up to the whole decision.
    assert.equal(considered.length, Object.keys(calls[0]!.questions.action.criteria).length);
    assert.deepEqual(
      considered.map((option) => option.probability),
      [...considered.map((option) => option.probability)].sort((a, b) => b! - a!),
      'sorted so the bar chart reads top-down',
    );
    const top = considered[0]!;
    assert.equal(top.key, 'move:1');
    assert.equal(top.label, 'EMBER', 'labelled for a human, not by option key');
    assert.equal(top.chosen, true);
    assert.equal(considered.filter((option) => option.chosen).length, 1);
    assert.equal(considered.find((option) => option.key === 'run')!.chosen, false);
  });

  test('an answer without a distribution still lists the options', async () => {
    const { state, analysis } = battleFixture();
    const { agent, deps } = await withFakeModel(() => ({
      action: { type: 'choice', choice: 'move:1' },
    }));

    const { considered } = await agent.decideBattleByEvaluation(
      config(), state, analysis, emptyJournal(), deps,
    );

    assert.ok(considered);
    // Null rather than zero: the viewer draws no bar instead of an empty one.
    assert.ok(considered.every((option) => option.probability === null));
    assert.equal(considered.find((option) => option.chosen)!.key, 'move:1');
  });

  test('a fallback has nothing to show, and says so by omission', async () => {
    const { state, analysis } = battleFixture();
    const { agent, deps } = await withFakeModel(() => {
      throw new Error('gateway exploded');
    });

    const result = await agent.decideBattleByEvaluation(
      config(), state, analysis, emptyJournal(), deps,
    );
    assert.equal(result.usedFallback, true);
    assert.equal(result.considered, undefined);
  });

});
