import { ADDR, describeStatus, decodeBadges } from './addresses.ts';
import { decodeString } from './charmap.ts';
import { speciesName } from './data/species.ts';
import { getMove, moveName } from './data/moves.ts';
import { typeName, type TypeName } from './data/types.ts';
import { itemName } from './data/items.ts';
import { mapName } from './data/maps.ts';
import { readScreenText, isBattleMenu, isMoveMenu, type ScreenText } from './screen.ts';
import type { GameBoy } from '../emulator/gameboy.ts';

export interface MoveSlot {
  /** 0-3, the position in the move list — this is what the cursor selects. */
  index: number;
  id: number;
  name: string;
  type: TypeName | 'UNKNOWN';
  power: number;
  accuracy: number | null;
  pp: number;
  special?: string;
  note?: string;
}

export interface PokemonState {
  slot: number;
  species: string;
  nickname: string;
  level: number;
  hp: number;
  maxHp: number;
  hpPercent: number;
  status: string;
  types: (TypeName | 'UNKNOWN')[];
  moves: MoveSlot[];
  stats?: { attack: number; defense: number; speed: number; special: number };
  fainted: boolean;
}

export interface StatStages {
  attack: number;
  defense: number;
  speed: number;
  special: number;
  accuracy: number;
  evasion: number;
}

export interface BattleSide extends PokemonState {
  statStages: StatStages;
}

export interface BattleState {
  kind: 'wild' | 'trainer';
  /** Safari Zone and the Viridian tutorial battle have restricted menus. */
  variant: 'normal' | 'old-man-tutorial' | 'safari';
  player: BattleSide;
  enemy: BattleSide;
}

export interface WorldState {
  map: number;
  mapName: string;
  x: number;
  y: number;
  money: number;
  badges: string[];
  playerName: string;
  party: PokemonState[];
  bag: { item: string; count: number }[];
}

export interface GameState {
  frame: number;
  mode: 'battle' | 'overworld';
  screen: ScreenText;
  menu: { cursorIndex: number; maxItem: number };
  ui: {
    battleMenuOpen: boolean;
    moveMenuOpen: boolean;
    awaitingTextInput: boolean;
  };
  battle: BattleState | null;
  world: WorldState;
}

const NEUTRAL_STAGE = 7;

function readMoveSlots(
  gb: GameBoy,
  movesAddr: number,
  ppAddr: number,
): MoveSlot[] {
  const slots: MoveSlot[] = [];
  for (let i = 0; i < 4; i++) {
    const id = gb.readByte(movesAddr + i);
    if (id === 0) continue;
    const data = getMove(id);
    slots.push({
      index: i,
      id,
      name: moveName(id),
      type: data?.type ?? 'UNKNOWN',
      power: data?.power ?? 0,
      accuracy: data?.accuracy ?? null,
      // The top two bits of the PP byte are PP Up counters, not PP.
      pp: gb.readByte(ppAddr + i) & 0x3f,
      ...(data?.special ? { special: data.special } : {}),
      ...(data?.note ? { note: data.note } : {}),
    });
  }
  return slots;
}

function stagesFrom(gb: GameBoy, base: number[]): StatStages {
  const [atk, def, spe, spc, acc, eva] = base;
  const toStage = (addr: number | undefined) =>
    addr === undefined ? 0 : gb.readByte(addr) - NEUTRAL_STAGE;
  return {
    attack: toStage(atk),
    defense: toStage(def),
    speed: toStage(spe),
    special: toStage(spc),
    accuracy: toStage(acc),
    evasion: toStage(eva),
  };
}

function percent(hp: number, maxHp: number): number {
  return maxHp > 0 ? Math.round((hp / maxHp) * 100) : 0;
}

/** Read the six-slot party out of WRAM. */
export function readParty(gb: GameBoy): PokemonState[] {
  const count = Math.min(gb.readByte(ADDR.wPartyCount), 6);
  const party: PokemonState[] = [];

  for (let i = 0; i < count; i++) {
    const base = ADDR.wPartyMons + i * ADDR.PARTY_MON_SIZE;
    const f = ADDR.PARTY_MON;
    const hp = gb.readWord(base + f.hp);
    const maxHp = gb.readWord(base + f.maxHp);
    const nickBytes = gb.readRange(ADDR.wPartyMonNicks + i * ADDR.NICK_SIZE, ADDR.NICK_SIZE);

    party.push({
      slot: i,
      species: speciesName(gb.readByte(base + f.species)),
      nickname: decodeString(nickBytes),
      level: gb.readByte(base + f.level),
      hp,
      maxHp,
      hpPercent: percent(hp, maxHp),
      status: describeStatus(gb.readByte(base + f.status)),
      types: [typeName(gb.readByte(base + f.type1)), typeName(gb.readByte(base + f.type2))],
      moves: readMoveSlots(gb, base + f.moves, base + f.pp),
      stats: {
        attack: gb.readWord(base + f.attack),
        defense: gb.readWord(base + f.defense),
        speed: gb.readWord(base + f.speed),
        special: gb.readWord(base + f.special),
      },
      fainted: hp === 0,
    });
  }

  return party;
}

function readBag(gb: GameBoy): { item: string; count: number }[] {
  const count = Math.min(gb.readByte(ADDR.wNumBagItems), 20);
  const bytes = gb.readRange(ADDR.wBagItems, count * 2);
  const bag: { item: string; count: number }[] = [];
  for (let i = 0; i < count; i++) {
    const id = bytes[i * 2];
    const qty = bytes[i * 2 + 1];
    if (id === undefined || id === 0xff) break;
    bag.push({ item: itemName(id), count: qty ?? 0 });
  }
  return bag;
}

/** Money is stored as binary-coded decimal across three bytes. */
function readMoney(gb: GameBoy): number {
  const bytes = gb.readRange(ADDR.wPlayerMoney, 3);
  let value = 0;
  for (const byte of bytes) {
    value = value * 100 + (byte >> 4) * 10 + (byte & 0x0f);
  }
  return value;
}

function readBattle(gb: GameBoy, party: PokemonState[]): BattleState | null {
  const inBattle = gb.readByte(ADDR.wIsInBattle);
  if (inBattle === 0) return null;

  const B = ADDR.BATTLE_MON;
  const E = ADDR.ENEMY_MON;

  const playerHp = gb.readWord(B.hp);
  const playerMaxHp = gb.readWord(B.maxHp);
  const enemyHp = gb.readWord(E.hp);
  const enemyMaxHp = gb.readWord(E.maxHp);
  const partyPos = gb.readByte(B.partyPos);

  const battleType = gb.readByte(ADDR.wBattleType);
  const variant = battleType === 1 ? 'old-man-tutorial' : battleType === 2 ? 'safari' : 'normal';

  const player: BattleSide = {
    slot: partyPos,
    species: speciesName(gb.readByte(B.species)),
    nickname: decodeString(gb.readRange(ADDR.wBattleMonNick, ADDR.NICK_SIZE)),
    level: gb.readByte(B.level),
    hp: playerHp,
    maxHp: playerMaxHp,
    hpPercent: percent(playerHp, playerMaxHp),
    status: describeStatus(gb.readByte(B.status)),
    types: [typeName(gb.readByte(B.type1)), typeName(gb.readByte(B.type2))],
    moves: readMoveSlots(gb, B.moves, B.pp),
    stats: {
      attack: gb.readWord(B.attack),
      defense: gb.readWord(B.defense),
      speed: gb.readWord(B.speed),
      special: gb.readWord(B.special),
    },
    fainted: playerHp === 0,
    statStages: stagesFrom(gb, [
      ADDR.wPlayerMonAttackMod, ADDR.wPlayerMonDefenseMod, ADDR.wPlayerMonSpeedMod,
      ADDR.wPlayerMonSpecialMod, ADDR.wPlayerMonAccuracyMod, ADDR.wPlayerMonEvasionMod,
    ]),
  };

  const enemy: BattleSide = {
    slot: -1,
    species: speciesName(gb.readByte(E.species)),
    nickname: decodeString(gb.readRange(ADDR.wEnemyMonNick, ADDR.NICK_SIZE)),
    level: gb.readByte(E.level),
    hp: enemyHp,
    maxHp: enemyMaxHp,
    hpPercent: percent(enemyHp, enemyMaxHp),
    status: describeStatus(gb.readByte(E.status)),
    types: [typeName(gb.readByte(E.type1)), typeName(gb.readByte(E.type2))],
    moves: readMoveSlots(gb, E.moves, E.pp),
    stats: {
      attack: gb.readWord(E.attack),
      defense: gb.readWord(E.defense),
      speed: gb.readWord(E.speed),
      special: gb.readWord(E.special),
    },
    fainted: enemyHp === 0,
    statStages: stagesFrom(gb, [
      ADDR.wEnemyMonAttackMod, ADDR.wEnemyMonDefenseMod, ADDR.wEnemyMonSpeedMod,
      ADDR.wEnemyMonSpecialMod, ADDR.wEnemyMonAccuracyMod, ADDR.wEnemyMonEvasionMod,
    ]),
  };

  // Keep the party copy authoritative for HP when the active mon is mid-swap.
  const partyEntry = party[partyPos];
  if (partyEntry && player.species === partyEntry.species && player.maxHp === 0) {
    player.hp = partyEntry.hp;
    player.maxHp = partyEntry.maxHp;
    player.hpPercent = partyEntry.hpPercent;
  }

  return {
    kind: inBattle === 2 ? 'trainer' : 'wild',
    variant,
    player,
    enemy,
  };
}

/** Snapshot everything Jev is allowed to know, straight out of RAM. */
export function readGameState(gb: GameBoy): GameState {
  const screen = readScreenText(gb);
  const party = readParty(gb);
  const battle = readBattle(gb, party);

  return {
    frame: gb.frameCount,
    mode: battle ? 'battle' : 'overworld',
    screen,
    menu: {
      cursorIndex: gb.readByte(ADDR.wCurrentMenuItem),
      maxItem: gb.readByte(ADDR.wMaxMenuItem),
    },
    ui: {
      battleMenuOpen: battle !== null && isBattleMenu(screen),
      moveMenuOpen: battle !== null && isMoveMenu(screen) && !isBattleMenu(screen),
      awaitingTextInput: screen.awaitingInput,
    },
    battle,
    world: {
      map: gb.readByte(ADDR.wCurMap),
      mapName: mapName(gb.readByte(ADDR.wCurMap)),
      x: gb.readByte(ADDR.wXCoord),
      y: gb.readByte(ADDR.wYCoord),
      money: readMoney(gb),
      badges: decodeBadges(gb.readByte(ADDR.wObtainedBadges)),
      playerName: decodeString(gb.readRange(ADDR.wPlayerName, ADDR.NICK_SIZE)),
      party,
      bag: readBag(gb),
    },
  };
}
