import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveness, typeMultiplier, TYPE_IDS, isSpecialType } from '../src/game/data/types.ts';
import { MOVES, getMove, moveName } from '../src/game/data/moves.ts';
import { speciesName, SPECIES_COUNT } from '../src/game/data/species.ts';
import { itemName } from '../src/game/data/items.ts';
import { decodeString, decodeChar } from '../src/game/charmap.ts';
import { encodeString } from './helpers/fake-gameboy.ts';

describe('type chart', () => {
  test('covers the Gen 1 quirks that later generations changed', () => {
    // Ghost does nothing to Psychic in Gen 1 — the single most famous example.
    assert.equal(typeMultiplier(TYPE_IDS.GHOST, TYPE_IDS.PSYCHIC), 0);
    // Poison is strong against Bug in Gen 1 only.
    assert.equal(typeMultiplier(TYPE_IDS.POISON, TYPE_IDS.BUG), 2);
    // Bug is strong against Poison in Gen 1 only.
    assert.equal(typeMultiplier(TYPE_IDS.BUG, TYPE_IDS.POISON), 2);
    // Ice is not resisted by Fire in Gen 1's chart.
    assert.equal(typeMultiplier(TYPE_IDS.ICE, TYPE_IDS.FIRE), 1);
  });

  test('handles immunities and dual types', () => {
    assert.equal(typeMultiplier(TYPE_IDS.NORMAL, TYPE_IDS.GHOST), 0);
    assert.equal(typeMultiplier(TYPE_IDS.ELECTRIC, TYPE_IDS.GROUND), 0);
    // Electric vs Water/Flying (Gyarados) is 4x.
    assert.equal(effectiveness(TYPE_IDS.ELECTRIC, TYPE_IDS.WATER, TYPE_IDS.FLYING), 4);
    // Grass vs Bug/Poison (Weedle) is 0.25x.
    assert.equal(effectiveness(TYPE_IDS.GRASS, TYPE_IDS.BUG, TYPE_IDS.POISON), 0.25);
    // A single-typed defender must not have its type counted twice.
    assert.equal(effectiveness(TYPE_IDS.WATER, TYPE_IDS.FIRE, TYPE_IDS.FIRE), 2);
  });

  test('splits physical and special by type, as Gen 1 does', () => {
    assert.equal(isSpecialType(TYPE_IDS.FIRE), true);
    assert.equal(isSpecialType(TYPE_IDS.PSYCHIC), true);
    assert.equal(isSpecialType(TYPE_IDS.NORMAL), false);
    assert.equal(isSpecialType(TYPE_IDS.FLYING), false);
  });
});

describe('move table', () => {
  test('has all 165 Gen 1 moves with contiguous ids', () => {
    assert.equal(MOVES.length, 165);
    MOVES.forEach((move, index) => assert.equal(move.id, index + 1));
  });

  test('knows key move stats', () => {
    assert.equal(getMove(85)?.name, 'THUNDERBOLT');
    assert.equal(getMove(85)?.power, 95);
    assert.equal(getMove(63)?.name, 'HYPER BEAM');
    assert.equal(getMove(63)?.power, 150);
    // Blizzard is 90% accurate in Gen 1, not 70%.
    assert.equal(getMove(59)?.accuracy, 90);
    assert.equal(moveName(0), '-');
  });
});

describe('species and items', () => {
  test('maps internal indices, not Pokedex numbers', () => {
    assert.equal(speciesName(0x99), 'BULBASAUR');
    assert.equal(speciesName(0xb0), 'CHARMANDER');
    assert.equal(speciesName(0x01), 'RHYDON');
    assert.equal(SPECIES_COUNT, 151);
  });

  test('labels MissingNo. slots rather than pretending they are real', () => {
    assert.match(speciesName(0x1f), /MISSINGNO/);
  });

  test('derives TM and HM names', () => {
    assert.equal(itemName(0x04), 'POKE BALL');
    assert.equal(itemName(0xc4), 'HM01');
    assert.equal(itemName(0xc9), 'TM01');
  });
});

describe('text codec', () => {
  test('decodes names stored in RAM', () => {
    assert.equal(decodeString(encodeString('PIKACHU')), 'PIKACHU');
    assert.equal(decodeString(encodeString('RED', 11)), 'RED');
  });

  test('decodes the special tiles the harness keys off', () => {
    assert.equal(decodeChar(0x7f), ' ');
    assert.equal(decodeChar(0xed), '▶');
    assert.equal(decodeChar(0xee), '▼');
    assert.equal(decodeChar(0xf6), '0');
  });
});
