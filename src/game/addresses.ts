/**
 * Pokemon Red (US) WRAM addresses.
 *
 * Names follow the pokered disassembly so they can be cross-checked. Anything
 * Jev needs to know about the world comes from here rather than from pixels.
 */
export const ADDR = {
  // --- screen ------------------------------------------------------------
  /** wTileMap: the 20x18 grid of tiles currently on screen. */
  TILE_MAP: 0xc3a0,
  TILE_MAP_WIDTH: 20,
  TILE_MAP_HEIGHT: 18,

  // --- menus -------------------------------------------------------------
  wTopMenuItemY: 0xcc24,
  wTopMenuItemX: 0xcc25,
  /** Index of the highlighted entry in whatever menu is open. */
  wCurrentMenuItem: 0xcc26,
  wTileBehindCursor: 0xcc27,
  wMaxMenuItem: 0xcc28,
  wMenuWatchedKeys: 0xcc29,
  wLastMenuItem: 0xcc2a,
  wPlayerMonNumber: 0xcc2f,

  // --- battle ------------------------------------------------------------
  /** 0 = overworld, 1 = wild battle, 2 = trainer battle. */
  wIsInBattle: 0xd057,
  /** 0 = normal, 1 = old man tutorial, 2 = safari zone. */
  wBattleType: 0xd05a,
  wCurOpponent: 0xd059,
  wTrainerClass: 0xd031,
  wPlayerBattleStatus1: 0xd062,
  wPlayerBattleStatus2: 0xd063,
  wPlayerBattleStatus3: 0xd064,
  wEnemyBattleStatus1: 0xd067,
  wEnemyBattleStatus2: 0xd068,
  wEnemyBattleStatus3: 0xd069,
  wPlayerMoveNum: 0xcfd2,
  wEnemyMoveNum: 0xcfcc,
  /** Stat modifier stages, 7 = neutral. */
  wPlayerMonAttackMod: 0xcd1a,
  wPlayerMonDefenseMod: 0xcd1b,
  wPlayerMonSpeedMod: 0xcd1c,
  wPlayerMonSpecialMod: 0xcd1d,
  wPlayerMonAccuracyMod: 0xcd1e,
  wPlayerMonEvasionMod: 0xcd1f,
  wEnemyMonAttackMod: 0xcd2e,
  wEnemyMonDefenseMod: 0xcd2f,
  wEnemyMonSpeedMod: 0xcd30,
  wEnemyMonSpecialMod: 0xcd31,
  wEnemyMonAccuracyMod: 0xcd32,
  wEnemyMonEvasionMod: 0xcd33,

  /** wEnemyMon struct (the Pokemon currently out against us). */
  ENEMY_MON: {
    species: 0xcfe5,
    hp: 0xcfe6, // 2 bytes, big endian
    status: 0xcfe9,
    type1: 0xcfea,
    type2: 0xcfeb,
    catchRate: 0xcfec,
    moves: 0xcfed, // 4 bytes
    level: 0xcff3,
    maxHp: 0xcff4,
    attack: 0xcff6,
    defense: 0xcff8,
    speed: 0xcffa,
    special: 0xcffc,
    pp: 0xcffe, // 4 bytes
  },

  /** wBattleMon struct (our active Pokemon's in-battle copy). */
  BATTLE_MON: {
    species: 0xd014,
    hp: 0xd015,
    partyPos: 0xd017,
    status: 0xd018,
    type1: 0xd019,
    type2: 0xd01a,
    moves: 0xd01c,
    level: 0xd022,
    maxHp: 0xd023,
    attack: 0xd025,
    defense: 0xd027,
    speed: 0xd029,
    special: 0xd02b,
    pp: 0xd02d,
  },

  wEnemyMonNick: 0xcfda,
  wBattleMonNick: 0xd009,

  // --- party -------------------------------------------------------------
  wPartyCount: 0xd163,
  wPartySpecies: 0xd164,
  /** First wPartyMon struct; entries are 44 (0x2C) bytes apart. */
  wPartyMons: 0xd16b,
  PARTY_MON_SIZE: 0x2c,
  wPartyMonNicks: 0xd2b5,
  NICK_SIZE: 11,

  /** Offsets inside a wPartyMon struct. */
  PARTY_MON: {
    species: 0x00,
    hp: 0x01, // 2 bytes
    status: 0x04,
    type1: 0x05,
    type2: 0x06,
    catchRate: 0x07,
    moves: 0x08, // 4 bytes
    otId: 0x0c,
    exp: 0x0e, // 3 bytes
    pp: 0x1d, // 4 bytes
    level: 0x21,
    maxHp: 0x22, // 2 bytes
    attack: 0x24,
    defense: 0x26,
    speed: 0x28,
    special: 0x2a,
  },

  // --- player / world ----------------------------------------------------
  wPlayerName: 0xd158,
  wRivalName: 0xd34a,
  wPlayerMoney: 0xd347, // 3 bytes, binary-coded decimal
  wObtainedBadges: 0xd356,
  wCurMap: 0xd35e,
  wYCoord: 0xd361,
  wXCoord: 0xd362,
  wWalkBikeSurfState: 0xd700,
  wNumBagItems: 0xd31d,
  wBagItems: 0xd31e, // pairs of (item id, quantity), 0xFF terminated
  wJoyIgnore: 0xcd6b,
  wSpriteStateData1: 0xc100,
  /** Non-zero while a text box is being printed. */
  wTextBoxID: 0xd125,
} as const;

/** Status condition bits in the status byte. */
export const STATUS_BITS = {
  SLEEP_MASK: 0b0000_0111,
  POISONED: 1 << 3,
  BURNED: 1 << 4,
  FROZEN: 1 << 5,
  PARALYZED: 1 << 6,
} as const;

export function describeStatus(status: number): string {
  if (status === 0) return 'OK';
  const parts: string[] = [];
  const sleepTurns = status & STATUS_BITS.SLEEP_MASK;
  if (sleepTurns > 0) parts.push(`asleep (${sleepTurns} turns left)`);
  if (status & STATUS_BITS.POISONED) parts.push('poisoned');
  if (status & STATUS_BITS.BURNED) parts.push('burned');
  if (status & STATUS_BITS.FROZEN) parts.push('frozen');
  if (status & STATUS_BITS.PARALYZED) parts.push('paralyzed');
  return parts.length > 0 ? parts.join(', ') : 'OK';
}

export const BADGE_NAMES = [
  'BOULDER', 'CASCADE', 'THUNDER', 'RAINBOW',
  'SOUL', 'MARSH', 'VOLCANO', 'EARTH',
] as const;

export function decodeBadges(badgeByte: number): string[] {
  return BADGE_NAMES.filter((_, i) => (badgeByte >> i) & 1);
}
