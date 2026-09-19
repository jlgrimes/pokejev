import { effectiveness, effectivenessLabel, isSpecialType, TYPE_IDS, type TypeName } from './data/types.ts';
import { getMove } from './data/moves.ts';
import type { BattleSide, BattleState, MoveSlot } from './state.ts';

/** Gen 1 stat stage multipliers, indexed by stage + 6. */
const STAGE_MULTIPLIERS = [0.25, 0.28, 0.33, 0.4, 0.5, 0.66, 1, 1.5, 2, 2.5, 3, 3.5, 4];

export function stageMultiplier(stage: number): number {
  const clamped = Math.max(-6, Math.min(6, stage));
  return STAGE_MULTIPLIERS[clamped + 6] ?? 1;
}

function typeId(name: TypeName | 'UNKNOWN'): number {
  return name === 'UNKNOWN' ? TYPE_IDS.NORMAL : TYPE_IDS[name];
}

export interface DamageEstimate {
  min: number;
  max: number;
  /** Midpoint, which is the number worth reasoning about most of the time. */
  typical: number;
  /** Fraction of the target's *current* HP the typical roll removes. */
  fractionOfTargetHp: number;
}

/**
 * Gen 1 damage formula.
 *
 * Deliberately faithful to the original, including the integer truncation at
 * each step and the 217-255 random factor, so the numbers Jev reasons about
 * match what the game will actually roll.
 */
export function estimateDamage(params: {
  level: number;
  attack: number;
  defense: number;
  power: number;
  stab: boolean;
  typeMultiplier: number;
  targetHp: number;
}): DamageEstimate {
  const { level, attack, defense, power, stab, typeMultiplier, targetHp } = params;

  if (power <= 0 || typeMultiplier === 0 || defense <= 0) {
    return { min: 0, max: 0, typical: 0, fractionOfTargetHp: 0 };
  }

  let base = Math.floor(Math.floor((Math.floor((2 * level) / 5) + 2) * attack * power) / defense);
  base = Math.floor(base / 50) + 2;
  if (stab) base = Math.floor(base * 1.5);
  base = Math.floor(base * typeMultiplier);

  const min = Math.max(1, Math.floor((base * 217) / 255));
  const max = Math.max(1, base);
  const typical = Math.floor((min + max) / 2);

  return {
    min,
    max,
    typical,
    fractionOfTargetHp: targetHp > 0 ? Math.min(1, typical / targetHp) : 0,
  };
}

export interface MoveAnalysis {
  index: number;
  name: string;
  type: TypeName | 'UNKNOWN';
  power: number;
  accuracy: number | null;
  pp: number;
  effectiveness: number;
  effectivenessLabel: string;
  damage: DamageEstimate;
  /** true when even the worst roll knocks the target out. */
  guaranteedKo: boolean;
  /** true when the best roll knocks the target out. */
  possibleKo: boolean;
  /** Rough expected value: damage weighted by accuracy, as a share of target HP. */
  score: number;
  notes: string[];
}

function effectiveStat(base: number, stage: number, halved = false): number {
  const value = Math.floor(base * stageMultiplier(stage));
  return Math.max(1, halved ? Math.floor(value / 2) : value);
}

/** Analyse one move by an attacker against a defender. */
export function analyzeMove(move: MoveSlot, attacker: BattleSide, defender: BattleSide): MoveAnalysis {
  const data = getMove(move.id);
  const moveTypeId = typeId(move.type);
  const mult = effectiveness(moveTypeId, typeId(defender.types[0] ?? 'UNKNOWN'), typeId(defender.types[1] ?? 'UNKNOWN'));
  const stab = attacker.types.includes(move.type);
  const special = isSpecialType(moveTypeId);
  const notes: string[] = [];
  if (data?.note) notes.push(data.note);

  const burned = attacker.status.includes('burned');
  const attackStat = special
    ? effectiveStat(attacker.stats?.special ?? 1, attacker.statStages.special)
    : effectiveStat(attacker.stats?.attack ?? 1, attacker.statStages.attack, burned);
  const defenseStat = special
    ? effectiveStat(defender.stats?.special ?? 1, defender.statStages.special)
    : effectiveStat(defender.stats?.defense ?? 1, defender.statStages.defense);

  if (burned && !special) notes.push('burn is halving this Attack');

  let damage = estimateDamage({
    level: attacker.level,
    attack: attackStat,
    defense: defenseStat,
    power: move.power,
    stab,
    typeMultiplier: mult,
    targetHp: defender.hp,
  });

  // Moves that ignore the damage formula entirely.
  if (data?.special === 'fixed') {
    const fixed =
      move.id === 49 ? 20 // Sonicboom
      : move.id === 82 ? 40 // Dragon Rage
      : move.id === 162 ? Math.floor(defender.hp / 2) // Super Fang
      : attacker.level; // Seismic Toss / Night Shade
    const applies = mult > 0;
    damage = {
      min: applies ? fixed : 0,
      max: applies ? fixed : 0,
      typical: applies ? fixed : 0,
      fractionOfTargetHp: defender.hp > 0 && applies ? Math.min(1, fixed / defender.hp) : 0,
    };
    notes.push('fixed damage, ignores stats and type effectiveness (but not immunity)');
  }
  if (data?.special === 'ohko') {
    const faster = (attacker.stats?.speed ?? 0) >= (defender.stats?.speed ?? 0);
    notes.push(faster ? 'OHKO move: instant KO if it hits' : 'OHKO move fails: the target is faster');
  }
  if (data?.special === 'two-turn') notes.push('takes a turn to charge, leaving you open');
  if (data?.special === 'recharge') notes.push('locks you into a recharge turn unless it KOs');
  if (data?.special === 'multi-hit') notes.push('damage shown is per hit; it hits multiple times');

  if (mult === 0) notes.push(`${defender.species} is immune to ${move.type}`);
  if (move.pp === 0) notes.push('no PP left — this move cannot be selected');

  const guaranteedKo = damage.min >= defender.hp && defender.hp > 0 && damage.min > 0;
  const possibleKo = damage.max >= defender.hp && defender.hp > 0 && damage.max > 0;
  const accuracyFactor = (move.accuracy ?? 100) / 100;
  const hpShare = defender.hp > 0 ? Math.min(1, damage.typical / defender.hp) : 0;
  const score = move.pp === 0 ? -1 : hpShare * accuracyFactor;

  return {
    index: move.index,
    name: move.name,
    type: move.type,
    power: move.power,
    accuracy: move.accuracy,
    pp: move.pp,
    effectiveness: mult,
    effectivenessLabel: effectivenessLabel(mult),
    damage,
    guaranteedKo,
    possibleKo,
    score: Number(score.toFixed(3)),
    notes,
  };
}

export interface IncomingThreat {
  move: string;
  type: TypeName | 'UNKNOWN';
  effectiveness: number;
  damage: DamageEstimate;
  canKo: boolean;
}

export interface BattleAnalysis {
  /** Our options this turn, best first. */
  moves: MoveAnalysis[];
  /** Who moves first, accounting for paralysis. */
  fasterSide: 'player' | 'enemy' | 'tie';
  playerSpeed: number;
  enemySpeed: number;
  /** What the opponent can do to us, worst first. */
  incoming: IncomingThreat[];
  /** true when the opponent's best roll knocks our active Pokemon out. */
  inKoRange: boolean;
  /** Turns we can survive at the opponent's typical damage output. */
  turnsToSurvive: number;
  /** Party members that could switch in, healthiest first. */
  switchOptions: { slot: number; name: string; hpPercent: number; note: string }[];
  catchChance: number | null;
  summary: string;
}

/** Everything Jev should weigh before picking a battle action. */
export function analyzeBattle(
  battle: BattleState,
  party: { slot: number; species: string; nickname: string; hpPercent: number; fainted: boolean; types: (TypeName | 'UNKNOWN')[] }[],
  options: { fairPlay?: boolean } = {},
): BattleAnalysis {
  const { player, enemy } = battle;

  const moves = player.moves
    .map((move) => analyzeMove(move, player, enemy))
    .sort((a, b) => b.score - a.score);

  const paralyzed = (side: BattleSide) => (side.status.includes('paralyzed') ? 4 : 1);
  const playerSpeed = Math.floor(
    effectiveStat(player.stats?.speed ?? 1, player.statStages.speed) / paralyzed(player),
  );
  const enemySpeed = Math.floor(
    effectiveStat(enemy.stats?.speed ?? 1, enemy.statStages.speed) / paralyzed(enemy),
  );

  // In fair-play mode we do not peek at moves the opponent has not shown us.
  const incoming: IncomingThreat[] = options.fairPlay
    ? []
    : enemy.moves
        .filter((move) => move.power > 0)
        .map((move) => {
          const analysis = analyzeMove(move, enemy, player);
          return {
            move: move.name,
            type: move.type,
            effectiveness: analysis.effectiveness,
            damage: analysis.damage,
            canKo: analysis.possibleKo,
          };
        })
        .sort((a, b) => b.damage.typical - a.damage.typical);

  const worstIncoming = incoming[0]?.damage.typical ?? 0;
  const inKoRange = incoming.some((threat) => threat.canKo);
  const turnsToSurvive = worstIncoming > 0 ? Math.ceil(player.hp / worstIncoming) : Infinity;

  const switchOptions = party
    .filter((mon) => !mon.fainted && mon.slot !== player.slot)
    .map((mon) => ({
      slot: mon.slot,
      name: mon.nickname || mon.species,
      hpPercent: mon.hpPercent,
      note: `${mon.species} (${mon.types.filter((t) => t !== 'UNKNOWN').join('/')})`,
    }))
    .sort((a, b) => b.hpPercent - a.hpPercent);

  const catchChance =
    battle.kind === 'wild' ? estimateCatchChance(enemy, 'POKE BALL') : null;

  const best = moves[0];
  const summaryParts = [
    `${player.nickname || player.species} L${player.level} ${player.hp}/${player.maxHp} HP vs ${enemy.species} L${enemy.level} ${enemy.hp}/${enemy.maxHp} HP.`,
    `${playerSpeed >= enemySpeed ? 'You move first' : 'The opponent moves first'} (speed ${playerSpeed} vs ${enemySpeed}).`,
  ];
  if (best) {
    summaryParts.push(
      `Best expected move: ${best.name} (${best.effectivenessLabel}, ~${best.damage.typical} damage${best.guaranteedKo ? ', guaranteed KO' : best.possibleKo ? ', can KO' : ''}).`,
    );
  }
  if (inKoRange) summaryParts.push('WARNING: the opponent can knock you out this turn.');

  return {
    moves,
    fasterSide: playerSpeed === enemySpeed ? 'tie' : playerSpeed > enemySpeed ? 'player' : 'enemy',
    playerSpeed,
    enemySpeed,
    incoming,
    inKoRange,
    turnsToSurvive,
    switchOptions,
    catchChance,
    summary: summaryParts.join(' '),
  };
}

const BALL_FACTORS: Record<string, { ball: number; hp: number }> = {
  'POKE BALL': { ball: 255, hp: 8 },
  'GREAT BALL': { ball: 200, hp: 12 },
  'ULTRA BALL': { ball: 150, hp: 8 },
  'SAFARI BALL': { ball: 150, hp: 8 },
};

/**
 * Approximate Gen 1 catch probability.
 *
 * Follows the original two-roll algorithm: a status/catch-rate check, then an
 * HP-based check. Good enough to answer "throw now or weaken it first?".
 */
export function estimateCatchChance(
  enemy: { hp: number; maxHp: number; status: string },
  ball: string,
  catchRate = 45,
): number {
  if (ball === 'MASTER BALL') return 1;
  const factors = BALL_FACTORS[ball] ?? BALL_FACTORS['POKE BALL']!;
  if (enemy.maxHp <= 0) return 0;

  const statusBonus = /asleep|frozen/.test(enemy.status)
    ? 25
    : /poisoned|burned|paralyzed/.test(enemy.status)
      ? 12
      : 0;

  const firstCheck = Math.min(1, (catchRate + statusBonus) / factors.ball);

  let maxHp = enemy.maxHp * 4;
  let currentHp = Math.max(1, enemy.hp) * factors.hp;
  if (maxHp > 255) {
    maxHp = Math.max(1, maxHp >> 2);
    currentHp = Math.max(1, currentHp >> 2);
  }
  const f = Math.min(255, Math.floor((maxHp * 255) / currentHp));
  const secondCheck = Math.min(1, (f + 1) / 256);

  return Number((firstCheck * secondCheck).toFixed(3));
}
