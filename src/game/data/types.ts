/**
 * Generation 1 type system.
 *
 * The numeric ids are the ones Pokemon Red actually stores in RAM/ROM, which is
 * why they are sparse (0x00-0x08 for the "physical" types, 0x14+ for "special").
 * That split is not cosmetic: in Gen 1 a move is physical or special purely
 * because of its type, so `isSpecialType` drives the damage formula.
 */
export const TYPE_IDS = {
  NORMAL: 0x00,
  FIGHTING: 0x01,
  FLYING: 0x02,
  POISON: 0x03,
  GROUND: 0x04,
  ROCK: 0x05,
  BIRD: 0x06, // unused leftover type, only reachable via glitches
  BUG: 0x07,
  GHOST: 0x08,
  FIRE: 0x14,
  WATER: 0x15,
  GRASS: 0x16,
  ELECTRIC: 0x17,
  PSYCHIC: 0x18,
  ICE: 0x19,
  DRAGON: 0x1a,
} as const;

export type TypeName = keyof typeof TYPE_IDS;

const ID_TO_NAME = new Map<number, TypeName>(
  (Object.entries(TYPE_IDS) as [TypeName, number][]).map(([name, id]) => [id, name]),
);

export function typeName(id: number): TypeName | 'UNKNOWN' {
  return ID_TO_NAME.get(id) ?? 'UNKNOWN';
}

/** Gen 1 splits physical/special by type, not per move. */
const SPECIAL_TYPES = new Set<number>([
  TYPE_IDS.FIRE,
  TYPE_IDS.WATER,
  TYPE_IDS.GRASS,
  TYPE_IDS.ELECTRIC,
  TYPE_IDS.PSYCHIC,
  TYPE_IDS.ICE,
  TYPE_IDS.DRAGON,
]);

export function isSpecialType(typeId: number): boolean {
  return SPECIAL_TYPES.has(typeId);
}

/**
 * Non-neutral matchups only; anything absent is 1x.
 * This is the Gen 1 chart, which differs from later generations in ways that
 * matter a lot in Red: Ghost does nothing to Psychic, Poison is strong against
 * Bug, and Ice resists nothing but itself and Fire/Water.
 */
const CHART: Partial<Record<TypeName, Partial<Record<TypeName, number>>>> = {
  NORMAL: { ROCK: 0.5, GHOST: 0 },
  FIRE: { FIRE: 0.5, WATER: 0.5, GRASS: 2, ICE: 2, BUG: 2, ROCK: 0.5, DRAGON: 0.5 },
  WATER: { FIRE: 2, WATER: 0.5, GRASS: 0.5, GROUND: 2, ROCK: 2, DRAGON: 0.5 },
  ELECTRIC: { WATER: 2, ELECTRIC: 0.5, GRASS: 0.5, GROUND: 0, FLYING: 2, DRAGON: 0.5 },
  GRASS: {
    FIRE: 0.5, WATER: 2, GRASS: 0.5, POISON: 0.5, GROUND: 2,
    FLYING: 0.5, BUG: 0.5, ROCK: 2, DRAGON: 0.5,
  },
  ICE: { WATER: 0.5, GRASS: 2, ICE: 0.5, GROUND: 2, FLYING: 2, DRAGON: 2 },
  FIGHTING: {
    NORMAL: 2, ICE: 2, POISON: 0.5, FLYING: 0.5, PSYCHIC: 0.5,
    BUG: 0.5, ROCK: 2, GHOST: 0,
  },
  POISON: { GRASS: 2, POISON: 0.5, GROUND: 0.5, ROCK: 0.5, BUG: 2, GHOST: 0.5 },
  GROUND: { FIRE: 2, ELECTRIC: 2, GRASS: 0.5, POISON: 2, FLYING: 0, BUG: 0.5, ROCK: 2 },
  FLYING: { ELECTRIC: 0.5, GRASS: 2, FIGHTING: 2, BUG: 2, ROCK: 0.5 },
  PSYCHIC: { FIGHTING: 2, POISON: 2, PSYCHIC: 0.5 },
  BUG: { FIRE: 0.5, GRASS: 2, FIGHTING: 0.5, POISON: 2, FLYING: 0.5, GHOST: 0.5, PSYCHIC: 2 },
  ROCK: { FIRE: 2, ICE: 2, FIGHTING: 0.5, GROUND: 0.5, FLYING: 2, BUG: 2 },
  GHOST: { NORMAL: 0, PSYCHIC: 0, GHOST: 2 },
  DRAGON: { DRAGON: 2 },
};

/** Multiplier for one attacking type against one defending type. */
export function typeMultiplier(attacking: number, defending: number): number {
  const atk = typeName(attacking);
  const def = typeName(defending);
  if (atk === 'UNKNOWN' || def === 'UNKNOWN') return 1;
  return CHART[atk]?.[def] ?? 1;
}

/** Full effectiveness against a (possibly dual-typed) defender. */
export function effectiveness(
  moveType: number,
  defenderType1: number,
  defenderType2: number,
): number {
  let mult = typeMultiplier(moveType, defenderType1);
  if (defenderType2 !== defenderType1) mult *= typeMultiplier(moveType, defenderType2);
  return mult;
}

export function effectivenessLabel(mult: number): string {
  if (mult === 0) return 'no effect';
  if (mult >= 4) return 'quad super-effective';
  if (mult > 1) return 'super-effective';
  if (mult === 1) return 'neutral';
  if (mult >= 0.5) return 'not very effective';
  return 'quarter damage';
}
