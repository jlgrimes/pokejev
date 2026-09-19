import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGameBoy, encodeString } from './helpers/fake-gameboy.ts';
import { ADDR } from '../src/game/addresses.ts';
import { readGameState } from '../src/game/state.ts';
import { analyzeBattle, analyzeMove, estimateDamage, estimateCatchChance, stageMultiplier } from '../src/game/battle.ts';
import { TYPE_IDS } from '../src/game/data/types.ts';
import { fallbackBattleDecision } from '../src/jev/battle-agent.ts';

const SPECIES = { CHARMANDER: 0xb0, WEEDLE: 0x70, GENGAR: 0x0e, ALAKAZAM: 0x95 };
const MOVE = { SCRATCH: 10, EMBER: 52, GROWL: 45, LICK: 122, TACKLE: 33, POISON_STING: 40 };

/** Charmander (L10) facing a wild Weedle (L6), with the battle menu open. */
function charmanderVsWeedle(): FakeGameBoy {
  const gb = new FakeGameBoy();
  gb.fillScreen();

  gb.writeByte(ADDR.wIsInBattle, 1); // wild battle
  gb.writeByte(ADDR.wBattleType, 0);

  const B = ADDR.BATTLE_MON;
  gb.writeByte(B.species, SPECIES.CHARMANDER);
  gb.writeWord(B.hp, 30);
  gb.writeWord(B.maxHp, 30);
  gb.writeByte(B.level, 10);
  gb.writeByte(B.status, 0);
  gb.writeByte(B.type1, TYPE_IDS.FIRE);
  gb.writeByte(B.type2, TYPE_IDS.FIRE);
  gb.writeBytes(B.moves, [MOVE.SCRATCH, MOVE.EMBER, MOVE.GROWL, 0]);
  gb.writeBytes(B.pp, [35, 25, 40, 0]);
  gb.writeWord(B.attack, 13);
  gb.writeWord(B.defense, 12);
  gb.writeWord(B.speed, 16);
  gb.writeWord(B.special, 14);
  gb.writeByte(B.partyPos, 0);
  gb.writeBytes(ADDR.wBattleMonNick, encodeString('CHARMANDER', 11));

  const E = ADDR.ENEMY_MON;
  gb.writeByte(E.species, SPECIES.WEEDLE);
  gb.writeWord(E.hp, 20);
  gb.writeWord(E.maxHp, 20);
  gb.writeByte(E.level, 6);
  gb.writeByte(E.status, 0);
  gb.writeByte(E.type1, TYPE_IDS.BUG);
  gb.writeByte(E.type2, TYPE_IDS.POISON);
  gb.writeBytes(E.moves, [MOVE.POISON_STING, 0, 0, 0]);
  gb.writeBytes(E.pp, [35, 0, 0, 0]);
  gb.writeWord(E.attack, 9);
  gb.writeWord(E.defense, 8);
  gb.writeWord(E.speed, 10);
  gb.writeWord(E.special, 8);

  // Neutral stat stages on both sides.
  for (const address of [
    ADDR.wPlayerMonAttackMod, ADDR.wPlayerMonDefenseMod, ADDR.wPlayerMonSpeedMod,
    ADDR.wPlayerMonSpecialMod, ADDR.wPlayerMonAccuracyMod, ADDR.wPlayerMonEvasionMod,
    ADDR.wEnemyMonAttackMod, ADDR.wEnemyMonDefenseMod, ADDR.wEnemyMonSpeedMod,
    ADDR.wEnemyMonSpecialMod, ADDR.wEnemyMonAccuracyMod, ADDR.wEnemyMonEvasionMod,
  ]) {
    gb.writeByte(address, 7);
  }

  // One party member mirroring the active Pokemon.
  gb.writeByte(ADDR.wPartyCount, 1);
  gb.writeByte(ADDR.wPartySpecies, SPECIES.CHARMANDER);
  const P = ADDR.PARTY_MON;
  gb.writeByte(ADDR.wPartyMons + P.species, SPECIES.CHARMANDER);
  gb.writeWord(ADDR.wPartyMons + P.hp, 30);
  gb.writeWord(ADDR.wPartyMons + P.maxHp, 30);
  gb.writeByte(ADDR.wPartyMons + P.level, 10);
  gb.writeByte(ADDR.wPartyMons + P.type1, TYPE_IDS.FIRE);
  gb.writeByte(ADDR.wPartyMons + P.type2, TYPE_IDS.FIRE);
  gb.writeBytes(ADDR.wPartyMons + P.moves, [MOVE.SCRATCH, MOVE.EMBER, MOVE.GROWL, 0]);
  gb.writeBytes(ADDR.wPartyMons + P.pp, [35, 25, 40, 0]);
  gb.writeBytes(ADDR.wPartyMonNicks, encodeString('CHARMANDER', 11));

  // The battle menu, as it appears on screen.
  gb.writeScreenText(14, 9, '▶FIGHT');
  gb.writeScreenText(14, 15, 'PKMN');
  gb.writeScreenText(16, 9, 'ITEM');
  gb.writeScreenText(16, 15, 'RUN');

  return gb;
}

describe('reading battle state from RAM', () => {
  test('parses both sides of the battle', () => {
    const state = readGameState(charmanderVsWeedle().asGameBoy());

    assert.equal(state.mode, 'battle');
    assert.equal(state.battle?.kind, 'wild');
    assert.equal(state.battle?.player.species, 'CHARMANDER');
    assert.equal(state.battle?.player.hp, 30);
    assert.equal(state.battle?.player.level, 10);
    assert.deepEqual(state.battle?.player.types, ['FIRE', 'FIRE']);
    assert.equal(state.battle?.enemy.species, 'WEEDLE');
    assert.deepEqual(state.battle?.enemy.types, ['BUG', 'POISON']);
    assert.equal(state.ui.battleMenuOpen, true);
  });

  test('reads moves with their remaining PP, skipping empty slots', () => {
    const state = readGameState(charmanderVsWeedle().asGameBoy());
    const moves = state.battle!.player.moves;

    assert.equal(moves.length, 3); // the empty fourth slot is not listed
    assert.deepEqual(moves.map((move) => move.name), ['SCRATCH', 'EMBER', 'GROWL']);
    assert.equal(moves[1]!.pp, 25);
    assert.equal(moves[1]!.type, 'FIRE');
  });

  test('masks the PP Up bits out of the PP byte', () => {
    const gb = charmanderVsWeedle();
    gb.writeBytes(ADDR.BATTLE_MON.pp, [0xc0 | 20, 25, 40, 0]); // 3 PP Ups applied
    const state = readGameState(gb.asGameBoy());
    assert.equal(state.battle!.player.moves[0]!.pp, 20);
  });
});

describe('battle analysis', () => {
  test('ranks the super-effective STAB move first', () => {
    const state = readGameState(charmanderVsWeedle().asGameBoy());
    const analysis = analyzeBattle(state.battle!, state.world.party);

    assert.equal(analysis.moves[0]!.name, 'EMBER');
    assert.equal(analysis.moves[0]!.effectiveness, 2);
    assert.equal(analysis.moves[0]!.effectivenessLabel, 'super-effective');
    // Ember out-damages Scratch here thanks to STAB plus type advantage.
    const scratch = analysis.moves.find((move) => move.name === 'SCRATCH')!;
    assert.ok(analysis.moves[0]!.damage.typical > scratch.damage.typical);
  });

  test('scores a status move below any attack', () => {
    const state = readGameState(charmanderVsWeedle().asGameBoy());
    const analysis = analyzeBattle(state.battle!, state.world.party);
    const growl = analysis.moves.find((move) => move.name === 'GROWL')!;
    assert.equal(growl.damage.typical, 0);
    assert.ok(analysis.moves.indexOf(growl) > 0);
  });

  test('flags a guaranteed knockout', () => {
    const gb = charmanderVsWeedle();
    gb.writeWord(ADDR.ENEMY_MON.hp, 3); // barely alive
    const state = readGameState(gb.asGameBoy());
    const analysis = analyzeBattle(state.battle!, state.world.party);

    assert.equal(analysis.moves[0]!.guaranteedKo, true);
  });

  test('reports who moves first, accounting for paralysis', () => {
    const gb = charmanderVsWeedle();
    let state = readGameState(gb.asGameBoy());
    assert.equal(analyzeBattle(state.battle!, state.world.party).fasterSide, 'player');

    gb.writeByte(ADDR.BATTLE_MON.status, 1 << 6); // paralyzed: speed quartered
    state = readGameState(gb.asGameBoy());
    assert.equal(analyzeBattle(state.battle!, state.world.party).fasterSide, 'enemy');
  });

  test('warns when the opponent can knock us out', () => {
    const gb = charmanderVsWeedle();
    gb.writeWord(ADDR.BATTLE_MON.hp, 2);
    gb.writeByte(ADDR.ENEMY_MON.level, 50);
    gb.writeWord(ADDR.ENEMY_MON.attack, 90);
    const state = readGameState(gb.asGameBoy());
    const analysis = analyzeBattle(state.battle!, state.world.party);

    assert.equal(analysis.inKoRange, true);
    assert.match(analysis.summary, /knock you out/);
  });

  test('hides enemy movesets in fair-play mode', () => {
    const state = readGameState(charmanderVsWeedle().asGameBoy());
    const fair = analyzeBattle(state.battle!, state.world.party, { fairPlay: true });
    const full = analyzeBattle(state.battle!, state.world.party);

    assert.equal(fair.incoming.length, 0);
    assert.ok(full.incoming.length > 0);
  });

  test('respects stat stages in the damage estimate', () => {
    const gb = charmanderVsWeedle();
    const before = analyzeBattle(
      readGameState(gb.asGameBoy()).battle!, [],
    ).moves.find((m) => m.name === 'SCRATCH')!;

    gb.writeByte(ADDR.wPlayerMonAttackMod, 9); // +2 Attack stages
    const after = analyzeBattle(
      readGameState(gb.asGameBoy()).battle!, [],
    ).moves.find((m) => m.name === 'SCRATCH')!;

    assert.ok(after.damage.typical > before.damage.typical);
  });
});

describe('Gen 1 damage formula', () => {
  test('produces the documented range shape', () => {
    const damage = estimateDamage({
      level: 50, attack: 100, defense: 100, power: 100,
      stab: false, typeMultiplier: 1, targetHp: 200,
    });
    // Worked by hand: ((2*50/5)+2)=22, *100*100/100=2200, /50=44, +2=46.
    assert.equal(damage.max, 46);
    // The damage roll is 217/255 of the maximum at worst.
    assert.equal(damage.min, Math.floor((46 * 217) / 255));
    assert.ok(damage.min < damage.max);
  });

  test('applies STAB and type multipliers', () => {
    const base = { level: 20, attack: 50, defense: 50, power: 60, targetHp: 100 };
    const plain = estimateDamage({ ...base, stab: false, typeMultiplier: 1 });
    const stab = estimateDamage({ ...base, stab: true, typeMultiplier: 1 });
    const superEffective = estimateDamage({ ...base, stab: false, typeMultiplier: 2 });

    assert.ok(stab.max > plain.max);
    assert.ok(superEffective.max >= plain.max * 2 - 1);
  });

  test('an immune target takes nothing', () => {
    const damage = estimateDamage({
      level: 50, attack: 100, defense: 100, power: 100,
      stab: true, typeMultiplier: 0, targetHp: 100,
    });
    assert.equal(damage.max, 0);
  });

  test('stat stages follow the Gen 1 table', () => {
    assert.equal(stageMultiplier(0), 1);
    assert.equal(stageMultiplier(2), 2);
    assert.equal(stageMultiplier(6), 4);
    assert.equal(stageMultiplier(-2), 0.5);
    assert.equal(stageMultiplier(99), 4); // clamped
  });
});

describe('the Gen 1 Ghost/Psychic trap', () => {
  test('a Ghost move against a Psychic type is flagged as useless', () => {
    const gb = charmanderVsWeedle();
    gb.writeByte(ADDR.BATTLE_MON.species, SPECIES.GENGAR);
    gb.writeByte(ADDR.BATTLE_MON.type1, TYPE_IDS.GHOST);
    gb.writeByte(ADDR.BATTLE_MON.type2, TYPE_IDS.POISON);
    gb.writeBytes(ADDR.BATTLE_MON.moves, [MOVE.LICK, MOVE.TACKLE, 0, 0]);
    gb.writeBytes(ADDR.BATTLE_MON.pp, [30, 35, 0, 0]);
    gb.writeByte(ADDR.ENEMY_MON.species, SPECIES.ALAKAZAM);
    gb.writeByte(ADDR.ENEMY_MON.type1, TYPE_IDS.PSYCHIC);
    gb.writeByte(ADDR.ENEMY_MON.type2, TYPE_IDS.PSYCHIC);

    const state = readGameState(gb.asGameBoy());
    const analysis = analyzeBattle(state.battle!, state.world.party);
    const lick = analysis.moves.find((move) => move.name === 'LICK')!;

    assert.equal(lick.effectiveness, 0);
    assert.equal(lick.damage.typical, 0);
    assert.ok(lick.notes.some((note) => /immune/.test(note)));
    // And the heuristic must not pick it.
    assert.notEqual(fallbackBattleDecision(analysis).moveIndex, lick.index);
  });
});

describe('fallback decision making', () => {
  test('never selects a move that is out of PP', () => {
    const gb = charmanderVsWeedle();
    gb.writeBytes(ADDR.BATTLE_MON.pp, [0, 25, 40, 0]); // Scratch exhausted
    const state = readGameState(gb.asGameBoy());
    const analysis = analyzeBattle(state.battle!, state.world.party);

    const decision = fallbackBattleDecision(analysis);
    const chosen = analysis.moves.find((move) => move.index === decision.moveIndex)!;
    assert.ok(chosen.pp > 0);
    assert.equal(decision.action, 'fight');
  });
});

describe('catch odds', () => {
  test('weakening and status improve the chance', () => {
    const healthy = estimateCatchChance({ hp: 20, maxHp: 20, status: 'OK' }, 'POKE BALL');
    const weakened = estimateCatchChance({ hp: 1, maxHp: 20, status: 'OK' }, 'POKE BALL');
    const asleep = estimateCatchChance({ hp: 1, maxHp: 20, status: 'asleep (2 turns left)' }, 'POKE BALL');

    assert.ok(weakened > healthy);
    assert.ok(asleep >= weakened);
    assert.equal(estimateCatchChance({ hp: 20, maxHp: 20, status: 'OK' }, 'MASTER BALL'), 1);
  });

  test('a better ball beats a worse one', () => {
    const target = { hp: 10, maxHp: 40, status: 'OK' };
    assert.ok(
      estimateCatchChance(target, 'ULTRA BALL') > estimateCatchChance(target, 'POKE BALL'),
    );
  });
});

describe('analyzeMove directly', () => {
  test('halves Attack for a burned attacker', () => {
    const gb = charmanderVsWeedle();
    const healthy = readGameState(gb.asGameBoy()).battle!;
    gb.writeByte(ADDR.BATTLE_MON.status, 1 << 4); // burned
    const burned = readGameState(gb.asGameBoy()).battle!;

    const before = analyzeMove(healthy.player.moves[0]!, healthy.player, healthy.enemy);
    const after = analyzeMove(burned.player.moves[0]!, burned.player, burned.enemy);

    assert.ok(after.damage.typical < before.damage.typical);
    assert.ok(after.notes.some((note) => /burn/.test(note)));
  });
});
