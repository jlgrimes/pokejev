// server/_lib/session.ts
import { gzipSync, gunzipSync } from "node:zlib";

// src/emulator/gameboy.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Gameboy from "serverboy";
import saveStateModule from "serverboy/src/gameboy_core/saveState.js";
var BUTTONS = ["RIGHT", "LEFT", "UP", "DOWN", "A", "B", "SELECT", "START"];
var SCREEN_WIDTH = 160;
var SCREEN_HEIGHT = 144;
var GameBoy = class _GameBoy {
  #gb;
  #core;
  #frames = 0;
  #rom = null;
  /** Called after every emulated frame. Used to stream video to the viewer. */
  onFrame = null;
  constructor() {
    this.#gb = new Gameboy();
  }
  /** Load a ROM buffer, optionally restoring battery-backed save data. */
  loadRom(rom, saveData) {
    this.#rom = Uint8Array.from(rom);
    this.#gb.loadRom(rom, saveData);
    const privateKey = Object.keys(this.#gb)[0];
    this.#core = privateKey ? this.#gb[privateKey]?.gameboy : void 0;
    this.#frames = 0;
  }
  static fromFile(romPath, savePath) {
    if (!existsSync(romPath)) {
      throw new Error(
        `ROM not found at ${romPath}. Supply your own legally obtained Pokemon Red ROM and point ROM_PATH at it (see README).`
      );
    }
    const gb = new _GameBoy();
    const save = savePath && existsSync(savePath) ? JSON.parse(readFileSync(savePath, "utf8")) : void 0;
    gb.loadRom(readFileSync(romPath), save);
    return gb;
  }
  get frameCount() {
    return this.#frames;
  }
  /** Advance exactly one video frame. */
  step() {
    this.#gb.doFrame();
    this.#frames++;
    this.onFrame?.(this);
  }
  /** Advance `count` frames with no input. */
  advance(count) {
    for (let i = 0; i < count; i++) this.step();
  }
  /**
   * Press one or more buttons.
   *
   * serverboy releases keys at the end of every frame, so holding means
   * re-pressing each frame. Defaults are tuned for Pokemon Red's input polling:
   * anything shorter than ~4 frames is unreliable.
   */
  press(buttons, options = {}) {
    const list = Array.isArray(buttons) ? buttons : [buttons];
    const hold = options.hold ?? 8;
    const release = options.release ?? 8;
    for (let i = 0; i < hold; i++) {
      this.#gb.pressKeys(list);
      this.step();
    }
    this.advance(release);
  }
  /** Read a single byte of the Game Boy address space. */
  readByte(address) {
    return this.#gb.getMemory()[address] ?? 0;
  }
  /** Read a big-endian 16-bit value (the layout Pokemon uses for HP and stats). */
  readWord(address) {
    const memory = this.#gb.getMemory();
    return (memory[address] ?? 0) << 8 | (memory[address + 1] ?? 0);
  }
  readRange(start, length) {
    const memory = this.#gb.getMemory();
    const out = new Array(length);
    for (let i = 0; i < length; i++) out[i] = memory[start + i] ?? 0;
    return out;
  }
  /** The whole address space. Cheap — serverboy hands back its live array. */
  memory() {
    return this.#gb.getMemory();
  }
  /** Current frame as RGBA bytes, 160x144. */
  screen() {
    return this.#gb.getScreen();
  }
  /** Battery-backed SRAM, i.e. what an in-game SAVE writes to. */
  sram() {
    return this.#gb.getSaveData();
  }
  writeSram(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.sram()));
  }
  /**
   * Full emulator snapshot (CPU, RAM, VRAM, timers) — not the in-game save.
   * Useful for rewinding a bad decision or for replaying a battle.
   */
  saveState(options = {}) {
    if (!this.#core) throw new Error("No ROM loaded; cannot save state.");
    const state = saveStateModule.saveState.call(this.#core);
    if (options.includeRom === false) {
      state[0] = null;
      return { frames: this.#frames, state, romStripped: true };
    }
    return { frames: this.#frames, state };
  }
  loadState(snapshot) {
    if (!this.#core) throw new Error("No ROM loaded; cannot restore state.");
    const state = snapshot.state.slice();
    if (state[0] === null || state[0] === void 0) {
      if (!this.#rom) throw new Error("Snapshot has no ROM and none is loaded.");
      state[0] = Array.from(this.#rom);
    }
    saveStateModule.returnFromState.call(this.#core, state);
    this.#frames = snapshot.frames;
  }
  /**
   * Write a snapshot to disk. The ROM is left out — it is reloaded from the
   * cartridge on restore, so including a copy in every autosave just burns
   * megabytes of disk and write bandwidth.
   */
  writeStateFile(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.saveState({ includeRom: false })));
  }
  readStateFile(path) {
    this.loadState(JSON.parse(readFileSync(path, "utf8")));
  }
};

// server/_lib/rom.ts
import { readFile as readFile2 } from "node:fs/promises";

// server/_lib/storage.ts
import { put, get, del, head } from "@vercel/blob";
import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { dirname as dirname2, join } from "node:path";
var localRoot = () => process.env.LOCAL_STORAGE_DIR ?? ".data";
var localStorage = {
  kind: "local",
  async read(key) {
    try {
      return await readFile(join(localRoot(), key));
    } catch {
      return null;
    }
  },
  async write(key, data) {
    const path = join(localRoot(), key);
    await mkdir(dirname2(path), { recursive: true });
    await writeFile(path, data);
  },
  async remove(key) {
    await unlink(join(localRoot(), key)).catch(() => {
    });
  },
  async stat(key) {
    return await stat(join(localRoot(), key)).then((info) => info.size).catch(() => null);
  }
};
var blobStorage = {
  kind: "blob",
  async read(key) {
    const result = await get(key, { access: "private", useCache: false }).catch(() => null);
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const chunks = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },
  async write(key, data, contentType = "application/octet-stream") {
    await put(key, data, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 0
    });
  },
  async remove(key) {
    await del(key).catch(() => {
    });
  },
  async stat(key) {
    const info = await head(key).catch(() => null);
    return info?.size ?? null;
  }
};
function hasBlobCredentials() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}
function getStorage() {
  if (hasBlobCredentials()) return blobStorage;
  if (process.env.VERCEL) {
    throw new Error(
      "No Blob store is connected to this project. Create one in the Vercel dashboard (Storage \u2192 Create Database \u2192 Blob), connect it to this project, and redeploy so BLOB_STORE_ID is available to the functions."
    );
  }
  return localStorage;
}

// server/_lib/rom.ts
var cached = null;
var ROM_KEY = process.env.ROM_BLOB_KEY ?? "rom/pokemon_red.gb";
async function loadRom() {
  if (cached) return cached;
  const localPath = process.env.ROM_PATH;
  if (localPath) {
    const local = await readFile2(localPath).catch(() => null);
    if (local) {
      cached = local;
      return cached;
    }
  }
  const stored = await getStorage().read(ROM_KEY);
  if (!stored) {
    throw new Error(
      `No ROM found at "${ROM_KEY}". Upload your own Pokemon Red dump with \`npm run upload-rom -- <path-to-rom.gb>\` before starting a run.`
    );
  }
  cached = stored;
  return cached;
}

// src/jev/journal.ts
function emptyJournal() {
  return {
    goal: "Get out of the house, meet PROF.OAK, and pick a starter Pokemon.",
    notes: [],
    recent: [],
    stats: { turns: 0, battlesEntered: 0, battlesWon: 0, movesChosen: 0, pokemonCaught: 0 }
  };
}

// server/_lib/session.ts
var sessionKey = (id) => `sessions/${id}.json.gz`;
async function openSession(id) {
  const rom = await loadRom();
  const gb = new GameBoy();
  gb.loadRom(rom);
  const stored = await getStorage().read(sessionKey(id));
  if (!stored) {
    gb.advance(600);
    for (let i = 0; i < 6; i++) gb.press("START", { hold: 6, release: 30 });
    gb.advance(120);
    return { gb, journal: emptyJournal(), turns: 0, isNew: true };
  }
  const data = JSON.parse(gunzipSync(stored).toString("utf8"));
  gb.loadState(data.snapshot);
  return {
    gb,
    journal: { ...emptyJournal(), ...data.journal },
    turns: data.turns,
    isNew: false
  };
}
async function saveSession(id, gb, journal, turns) {
  const data = {
    version: 1,
    snapshot: gb.saveState({ includeRom: false }),
    journal,
    turns,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const packed = gzipSync(Buffer.from(JSON.stringify(data)));
  await getStorage().write(sessionKey(id), packed, "application/gzip");
  return packed.length;
}

// src/emulator/png.ts
import { PNG } from "pngjs";
function screenToPng(screen, scale = 3) {
  const png = new PNG({ width: SCREEN_WIDTH * scale, height: SCREEN_HEIGHT * scale });
  for (let y = 0; y < SCREEN_HEIGHT * scale; y++) {
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < SCREEN_WIDTH * scale; x++) {
      const srcX = Math.floor(x / scale);
      const src = (srcY * SCREEN_WIDTH + srcX) * 4;
      const dst = (y * png.width + x) * 4;
      png.data[dst] = screen[src] ?? 0;
      png.data[dst + 1] = screen[src + 1] ?? 0;
      png.data[dst + 2] = screen[src + 2] ?? 0;
      png.data[dst + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// src/game/addresses.ts
var ADDR = {
  // --- screen ------------------------------------------------------------
  /** wTileMap: the 20x18 grid of tiles currently on screen. */
  TILE_MAP: 50080,
  TILE_MAP_WIDTH: 20,
  TILE_MAP_HEIGHT: 18,
  // --- menus -------------------------------------------------------------
  wTopMenuItemY: 52260,
  wTopMenuItemX: 52261,
  /** Index of the highlighted entry in whatever menu is open. */
  wCurrentMenuItem: 52262,
  wTileBehindCursor: 52263,
  wMaxMenuItem: 52264,
  wMenuWatchedKeys: 52265,
  wLastMenuItem: 52266,
  wPlayerMonNumber: 52271,
  // --- battle ------------------------------------------------------------
  /** 0 = overworld, 1 = wild battle, 2 = trainer battle. */
  wIsInBattle: 53335,
  /** 0 = normal, 1 = old man tutorial, 2 = safari zone. */
  wBattleType: 53338,
  wCurOpponent: 53337,
  wTrainerClass: 53297,
  wPlayerBattleStatus1: 53346,
  wPlayerBattleStatus2: 53347,
  wPlayerBattleStatus3: 53348,
  wEnemyBattleStatus1: 53351,
  wEnemyBattleStatus2: 53352,
  wEnemyBattleStatus3: 53353,
  wPlayerMoveNum: 53202,
  wEnemyMoveNum: 53196,
  /** Stat modifier stages, 7 = neutral. */
  wPlayerMonAttackMod: 52506,
  wPlayerMonDefenseMod: 52507,
  wPlayerMonSpeedMod: 52508,
  wPlayerMonSpecialMod: 52509,
  wPlayerMonAccuracyMod: 52510,
  wPlayerMonEvasionMod: 52511,
  wEnemyMonAttackMod: 52526,
  wEnemyMonDefenseMod: 52527,
  wEnemyMonSpeedMod: 52528,
  wEnemyMonSpecialMod: 52529,
  wEnemyMonAccuracyMod: 52530,
  wEnemyMonEvasionMod: 52531,
  /** wEnemyMon struct (the Pokemon currently out against us). */
  ENEMY_MON: {
    species: 53221,
    hp: 53222,
    // 2 bytes, big endian
    status: 53225,
    type1: 53226,
    type2: 53227,
    catchRate: 53228,
    moves: 53229,
    // 4 bytes
    level: 53235,
    maxHp: 53236,
    attack: 53238,
    defense: 53240,
    speed: 53242,
    special: 53244,
    pp: 53246
    // 4 bytes
  },
  /** wBattleMon struct (our active Pokemon's in-battle copy). */
  BATTLE_MON: {
    species: 53268,
    hp: 53269,
    partyPos: 53271,
    status: 53272,
    type1: 53273,
    type2: 53274,
    moves: 53276,
    level: 53282,
    maxHp: 53283,
    attack: 53285,
    defense: 53287,
    speed: 53289,
    special: 53291,
    pp: 53293
  },
  wEnemyMonNick: 53210,
  wBattleMonNick: 53257,
  // --- party -------------------------------------------------------------
  wPartyCount: 53603,
  wPartySpecies: 53604,
  /** First wPartyMon struct; entries are 44 (0x2C) bytes apart. */
  wPartyMons: 53611,
  PARTY_MON_SIZE: 44,
  wPartyMonNicks: 53941,
  NICK_SIZE: 11,
  /** Offsets inside a wPartyMon struct. */
  PARTY_MON: {
    species: 0,
    hp: 1,
    // 2 bytes
    status: 4,
    type1: 5,
    type2: 6,
    catchRate: 7,
    moves: 8,
    // 4 bytes
    otId: 12,
    exp: 14,
    // 3 bytes
    pp: 29,
    // 4 bytes
    level: 33,
    maxHp: 34,
    // 2 bytes
    attack: 36,
    defense: 38,
    speed: 40,
    special: 42
  },
  // --- player / world ----------------------------------------------------
  wPlayerName: 53592,
  wRivalName: 54090,
  wPlayerMoney: 54087,
  // 3 bytes, binary-coded decimal
  wObtainedBadges: 54102,
  wCurMap: 54110,
  wYCoord: 54113,
  wXCoord: 54114,
  wWalkBikeSurfState: 55040,
  wNumBagItems: 54045,
  wBagItems: 54046,
  // pairs of (item id, quantity), 0xFF terminated
  wJoyIgnore: 52587,
  wSpriteStateData1: 49408,
  /** Non-zero while a text box is being printed. */
  wTextBoxID: 53541
};
var STATUS_BITS = {
  SLEEP_MASK: 7,
  POISONED: 1 << 3,
  BURNED: 1 << 4,
  FROZEN: 1 << 5,
  PARALYZED: 1 << 6
};
function describeStatus(status) {
  if (status === 0) return "OK";
  const parts = [];
  const sleepTurns = status & STATUS_BITS.SLEEP_MASK;
  if (sleepTurns > 0) parts.push(`asleep (${sleepTurns} turns left)`);
  if (status & STATUS_BITS.POISONED) parts.push("poisoned");
  if (status & STATUS_BITS.BURNED) parts.push("burned");
  if (status & STATUS_BITS.FROZEN) parts.push("frozen");
  if (status & STATUS_BITS.PARALYZED) parts.push("paralyzed");
  return parts.length > 0 ? parts.join(", ") : "OK";
}
var BADGE_NAMES = [
  "BOULDER",
  "CASCADE",
  "THUNDER",
  "RAINBOW",
  "SOUL",
  "MARSH",
  "VOLCANO",
  "EARTH"
];
function decodeBadges(badgeByte) {
  return BADGE_NAMES.filter((_, i) => badgeByte >> i & 1);
}

// src/game/charmap.ts
var TABLE = {
  74: "PKMN",
  78: "\n",
  // line break within a text box
  79: "\n",
  80: "",
  // string terminator
  81: "\n",
  // paragraph break
  85: "\n",
  87: "",
  // end of text
  88: "",
  // prompt
  95: "",
  // end of dex entry
  127: " ",
  154: "(",
  155: ")",
  156: ":",
  157: ";",
  158: "[",
  159: "]",
  186: "\xE9",
  187: "'d",
  188: "'l",
  189: "'s",
  190: "'t",
  191: "'v",
  224: "'",
  225: "PK",
  226: "MN",
  227: "-",
  228: "'r",
  229: "'m",
  230: "?",
  231: "!",
  232: ".",
  237: "\u25B6",
  // the menu cursor arrow
  238: "\u25BC",
  // "press A to continue" arrow
  239: "\u2642",
  // male symbol
  240: "\xA5",
  241: "\xD7",
  242: ".",
  243: "/",
  244: ",",
  245: "\u2640"
};
for (let i = 0; i < 26; i++) {
  TABLE[128 + i] = String.fromCharCode(65 + i);
  TABLE[160 + i] = String.fromCharCode(97 + i);
}
for (let i = 0; i < 10; i++) {
  TABLE[246 + i] = String.fromCharCode(48 + i);
}
var MENU_CURSOR_TILE = 237;
var TEXT_PROMPT_TILE = 238;
var STRING_TERMINATOR = 80;
function decodeChar(byte) {
  const ch = TABLE[byte];
  return ch === void 0 ? " " : ch;
}
function decodeString(bytes, offset = 0, maxLength = 11) {
  let out = "";
  for (let i = 0; i < maxLength; i++) {
    const byte = bytes[offset + i];
    if (byte === void 0 || byte === STRING_TERMINATOR || byte === 0) break;
    out += decodeChar(byte);
  }
  return out.trim();
}

// src/game/data/species.ts
var INTERNAL = {
  1: "RHYDON",
  2: "KANGASKHAN",
  3: "NIDORAN_M",
  4: "CLEFAIRY",
  5: "SPEAROW",
  6: "VOLTORB",
  7: "NIDOKING",
  8: "SLOWBRO",
  9: "IVYSAUR",
  10: "EXEGGUTOR",
  11: "LICKITUNG",
  12: "EXEGGCUTE",
  13: "GRIMER",
  14: "GENGAR",
  15: "NIDORAN_F",
  16: "NIDOQUEEN",
  17: "CUBONE",
  18: "RHYHORN",
  19: "LAPRAS",
  20: "ARCANINE",
  21: "MEW",
  22: "GYARADOS",
  23: "SHELLDER",
  24: "TENTACOOL",
  25: "GASTLY",
  26: "SCYTHER",
  27: "STARYU",
  28: "BLASTOISE",
  29: "PINSIR",
  30: "TANGELA",
  33: "GROWLITHE",
  34: "ONIX",
  35: "FEAROW",
  36: "PIDGEY",
  37: "SLOWPOKE",
  38: "KADABRA",
  39: "GRAVELER",
  40: "CHANSEY",
  41: "MACHOKE",
  42: "MR_MIME",
  43: "HITMONLEE",
  44: "HITMONCHAN",
  45: "ARBOK",
  46: "PARASECT",
  47: "PSYDUCK",
  48: "DROWZEE",
  49: "GOLEM",
  51: "MAGMAR",
  53: "ELECTABUZZ",
  54: "MAGNETON",
  55: "KOFFING",
  57: "MANKEY",
  58: "SEEL",
  59: "DIGLETT",
  60: "TAUROS",
  64: "FARFETCHD",
  65: "VENONAT",
  66: "DRAGONITE",
  70: "DODUO",
  71: "POLIWAG",
  72: "JYNX",
  73: "MOLTRES",
  74: "ARTICUNO",
  75: "ZAPDOS",
  76: "DITTO",
  77: "MEOWTH",
  78: "KRABBY",
  82: "VULPIX",
  83: "NINETALES",
  84: "PIKACHU",
  85: "RAICHU",
  88: "DRATINI",
  89: "DRAGONAIR",
  90: "KABUTO",
  91: "KABUTOPS",
  92: "HORSEA",
  93: "SEADRA",
  96: "SANDSHREW",
  97: "SANDSLASH",
  98: "OMANYTE",
  99: "OMASTAR",
  100: "JIGGLYPUFF",
  101: "WIGGLYTUFF",
  102: "EEVEE",
  103: "FLAREON",
  104: "JOLTEON",
  105: "VAPOREON",
  106: "MACHOP",
  107: "ZUBAT",
  108: "EKANS",
  109: "PARAS",
  110: "POLIWHIRL",
  111: "POLIWRATH",
  112: "WEEDLE",
  113: "KAKUNA",
  114: "BEEDRILL",
  116: "DODRIO",
  117: "PRIMEAPE",
  118: "DUGTRIO",
  119: "VENOMOTH",
  120: "DEWGONG",
  123: "CATERPIE",
  124: "METAPOD",
  125: "BUTTERFREE",
  126: "MACHAMP",
  128: "GOLDUCK",
  129: "HYPNO",
  130: "GOLBAT",
  131: "MEWTWO",
  132: "SNORLAX",
  133: "MAGIKARP",
  136: "MUK",
  138: "KINGLER",
  139: "CLOYSTER",
  141: "ELECTRODE",
  142: "CLEFABLE",
  143: "WEEZING",
  144: "PERSIAN",
  145: "MAROWAK",
  147: "HAUNTER",
  148: "ABRA",
  149: "ALAKAZAM",
  150: "PIDGEOTTO",
  151: "PIDGEOT",
  152: "STARMIE",
  153: "BULBASAUR",
  154: "VENUSAUR",
  155: "TENTACRUEL",
  157: "GOLDEEN",
  158: "SEAKING",
  163: "PONYTA",
  164: "RAPIDASH",
  165: "RATTATA",
  166: "RATICATE",
  167: "NIDORINO",
  168: "NIDORINA",
  169: "GEODUDE",
  170: "PORYGON",
  171: "AERODACTYL",
  173: "MAGNEMITE",
  176: "CHARMANDER",
  177: "SQUIRTLE",
  178: "CHARMELEON",
  179: "WARTORTLE",
  180: "CHARIZARD",
  185: "ODDISH",
  186: "GLOOM",
  187: "VILEPLUME",
  188: "BELLSPROUT",
  189: "WEEPINBELL",
  190: "VICTREEBEL"
};
var DISPLAY = {
  NIDORAN_M: "NIDORAN-M",
  NIDORAN_F: "NIDORAN-F",
  MR_MIME: "MR.MIME",
  FARFETCHD: "FARFETCH'D"
};
function speciesName(internalId) {
  const raw = INTERNAL[internalId];
  if (!raw) return internalId === 0 ? "NONE" : `MISSINGNO_${internalId.toString(16).toUpperCase()}`;
  return DISPLAY[raw] ?? raw;
}
var SPECIES_COUNT = Object.keys(INTERNAL).length;

// src/game/data/types.ts
var TYPE_IDS = {
  NORMAL: 0,
  FIGHTING: 1,
  FLYING: 2,
  POISON: 3,
  GROUND: 4,
  ROCK: 5,
  BIRD: 6,
  // unused leftover type, only reachable via glitches
  BUG: 7,
  GHOST: 8,
  FIRE: 20,
  WATER: 21,
  GRASS: 22,
  ELECTRIC: 23,
  PSYCHIC: 24,
  ICE: 25,
  DRAGON: 26
};
var ID_TO_NAME = new Map(
  Object.entries(TYPE_IDS).map(([name, id]) => [id, name])
);
function typeName(id) {
  return ID_TO_NAME.get(id) ?? "UNKNOWN";
}
var SPECIAL_TYPES = /* @__PURE__ */ new Set([
  TYPE_IDS.FIRE,
  TYPE_IDS.WATER,
  TYPE_IDS.GRASS,
  TYPE_IDS.ELECTRIC,
  TYPE_IDS.PSYCHIC,
  TYPE_IDS.ICE,
  TYPE_IDS.DRAGON
]);
function isSpecialType(typeId2) {
  return SPECIAL_TYPES.has(typeId2);
}
var CHART = {
  NORMAL: { ROCK: 0.5, GHOST: 0 },
  FIRE: { FIRE: 0.5, WATER: 0.5, GRASS: 2, ICE: 2, BUG: 2, ROCK: 0.5, DRAGON: 0.5 },
  WATER: { FIRE: 2, WATER: 0.5, GRASS: 0.5, GROUND: 2, ROCK: 2, DRAGON: 0.5 },
  ELECTRIC: { WATER: 2, ELECTRIC: 0.5, GRASS: 0.5, GROUND: 0, FLYING: 2, DRAGON: 0.5 },
  GRASS: {
    FIRE: 0.5,
    WATER: 2,
    GRASS: 0.5,
    POISON: 0.5,
    GROUND: 2,
    FLYING: 0.5,
    BUG: 0.5,
    ROCK: 2,
    DRAGON: 0.5
  },
  ICE: { WATER: 0.5, GRASS: 2, ICE: 0.5, GROUND: 2, FLYING: 2, DRAGON: 2 },
  FIGHTING: {
    NORMAL: 2,
    ICE: 2,
    POISON: 0.5,
    FLYING: 0.5,
    PSYCHIC: 0.5,
    BUG: 0.5,
    ROCK: 2,
    GHOST: 0
  },
  POISON: { GRASS: 2, POISON: 0.5, GROUND: 0.5, ROCK: 0.5, BUG: 2, GHOST: 0.5 },
  GROUND: { FIRE: 2, ELECTRIC: 2, GRASS: 0.5, POISON: 2, FLYING: 0, BUG: 0.5, ROCK: 2 },
  FLYING: { ELECTRIC: 0.5, GRASS: 2, FIGHTING: 2, BUG: 2, ROCK: 0.5 },
  PSYCHIC: { FIGHTING: 2, POISON: 2, PSYCHIC: 0.5 },
  BUG: { FIRE: 0.5, GRASS: 2, FIGHTING: 0.5, POISON: 2, FLYING: 0.5, GHOST: 0.5, PSYCHIC: 2 },
  ROCK: { FIRE: 2, ICE: 2, FIGHTING: 0.5, GROUND: 0.5, FLYING: 2, BUG: 2 },
  GHOST: { NORMAL: 0, PSYCHIC: 0, GHOST: 2 },
  DRAGON: { DRAGON: 2 }
};
function typeMultiplier(attacking, defending) {
  const atk = typeName(attacking);
  const def = typeName(defending);
  if (atk === "UNKNOWN" || def === "UNKNOWN") return 1;
  return CHART[atk]?.[def] ?? 1;
}
function effectiveness(moveType, defenderType1, defenderType2) {
  let mult = typeMultiplier(moveType, defenderType1);
  if (defenderType2 !== defenderType1) mult *= typeMultiplier(moveType, defenderType2);
  return mult;
}
function effectivenessLabel(mult) {
  if (mult === 0) return "no effect";
  if (mult >= 4) return "quad super-effective";
  if (mult > 1) return "super-effective";
  if (mult === 1) return "neutral";
  if (mult >= 0.5) return "not very effective";
  return "quarter damage";
}

// src/game/data/moves.ts
var M = (id, name, type, power, accuracy, pp, special, note) => ({ id, name, type, power, accuracy, pp, ...special ? { special } : {}, ...note ? { note } : {} });
var MOVES = [
  M(1, "POUND", "NORMAL", 40, 100, 35),
  M(2, "KARATE CHOP", "NORMAL", 50, 100, 25, void 0, "high crit rate; Normal-type in Gen 1"),
  M(3, "DOUBLESLAP", "NORMAL", 15, 85, 10, "multi-hit", "hits 2-5 times"),
  M(4, "COMET PUNCH", "NORMAL", 18, 85, 15, "multi-hit", "hits 2-5 times"),
  M(5, "MEGA PUNCH", "NORMAL", 80, 85, 20),
  M(6, "PAY DAY", "NORMAL", 40, 100, 20, void 0, "scatters coins picked up after battle"),
  M(7, "FIRE PUNCH", "FIRE", 75, 100, 15, void 0, "10% burn"),
  M(8, "ICE PUNCH", "ICE", 75, 100, 15, void 0, "10% freeze"),
  M(9, "THUNDERPUNCH", "ELECTRIC", 75, 100, 15, void 0, "10% paralyze"),
  M(10, "SCRATCH", "NORMAL", 40, 100, 35),
  M(11, "VICEGRIP", "NORMAL", 55, 100, 30),
  M(12, "GUILLOTINE", "NORMAL", 0, 30, 5, "ohko", "instant KO if it hits and user is faster"),
  M(13, "RAZOR WIND", "NORMAL", 80, 75, 10, "two-turn", "charges one turn"),
  M(14, "SWORDS DANCE", "NORMAL", 0, null, 30, void 0, "sharply raises Attack"),
  M(15, "CUT", "NORMAL", 50, 95, 30, void 0, "field move: cuts small trees"),
  M(16, "GUST", "NORMAL", 40, 100, 35, void 0, "Normal-type in Gen 1"),
  M(17, "WING ATTACK", "FLYING", 35, 100, 35),
  M(18, "WHIRLWIND", "NORMAL", 0, 85, 20, void 0, "does nothing in Gen 1 trainer battles"),
  M(19, "FLY", "FLYING", 70, 95, 15, "two-turn", "field move: fly to visited towns"),
  M(20, "BIND", "NORMAL", 15, 75, 20, void 0, "traps the target"),
  M(21, "SLAM", "NORMAL", 80, 75, 20),
  M(22, "VINE WHIP", "GRASS", 35, 100, 10),
  M(23, "STOMP", "NORMAL", 65, 100, 20, void 0, "30% flinch"),
  M(24, "DOUBLE KICK", "FIGHTING", 30, 100, 30, "multi-hit", "hits twice"),
  M(25, "MEGA KICK", "NORMAL", 120, 75, 5),
  M(26, "JUMP KICK", "FIGHTING", 70, 95, 25, void 0, "crash damage on miss"),
  M(27, "ROLLING KICK", "FIGHTING", 60, 85, 15, void 0, "30% flinch"),
  M(28, "SAND-ATTACK", "NORMAL", 0, 100, 15, void 0, "lowers accuracy"),
  M(29, "HEADBUTT", "NORMAL", 70, 100, 15, void 0, "30% flinch"),
  M(30, "HORN ATTACK", "NORMAL", 65, 100, 25),
  M(31, "FURY ATTACK", "NORMAL", 15, 85, 20, "multi-hit", "hits 2-5 times"),
  M(32, "HORN DRILL", "NORMAL", 0, 30, 5, "ohko", "instant KO if it hits and user is faster"),
  M(33, "TACKLE", "NORMAL", 35, 95, 35),
  M(34, "BODY SLAM", "NORMAL", 85, 100, 15, void 0, "30% paralyze"),
  M(35, "WRAP", "NORMAL", 15, 85, 20, void 0, "traps the target"),
  M(36, "TAKE DOWN", "NORMAL", 90, 85, 20, "recoil", "1/4 recoil"),
  M(37, "THRASH", "NORMAL", 90, 100, 20, void 0, "locks in 3-4 turns then confuses user"),
  M(38, "DOUBLE-EDGE", "NORMAL", 100, 100, 15, "recoil", "1/4 recoil"),
  M(39, "TAIL WHIP", "NORMAL", 0, 100, 30, void 0, "lowers Defense"),
  M(40, "POISON STING", "POISON", 15, 100, 35, void 0, "20% poison"),
  M(41, "TWINEEDLE", "BUG", 25, 100, 20, "multi-hit", "hits twice, 20% poison"),
  M(42, "PIN MISSILE", "BUG", 14, 85, 20, "multi-hit", "hits 2-5 times"),
  M(43, "LEER", "NORMAL", 0, 100, 30, void 0, "lowers Defense"),
  M(44, "BITE", "NORMAL", 60, 100, 25, void 0, "Normal-type in Gen 1, 30% flinch"),
  M(45, "GROWL", "NORMAL", 0, 100, 40, void 0, "lowers Attack"),
  M(46, "ROAR", "NORMAL", 0, 100, 20, void 0, "does nothing in Gen 1 trainer battles"),
  M(47, "SING", "NORMAL", 0, 55, 15, void 0, "puts target to sleep"),
  M(48, "SUPERSONIC", "NORMAL", 0, 55, 20, void 0, "confuses target"),
  M(49, "SONICBOOM", "NORMAL", 0, 90, 20, "fixed", "always deals exactly 20 damage"),
  M(50, "DISABLE", "NORMAL", 0, 55, 20, void 0, "disables one of the target moves"),
  M(51, "ACID", "POISON", 40, 100, 30, void 0, "10% lower Defense"),
  M(52, "EMBER", "FIRE", 40, 100, 25, void 0, "10% burn"),
  M(53, "FLAMETHROWER", "FIRE", 95, 100, 15, void 0, "10% burn"),
  M(54, "MIST", "ICE", 0, null, 30, void 0, "blocks stat reduction"),
  M(55, "WATER GUN", "WATER", 40, 100, 25),
  M(56, "HYDRO PUMP", "WATER", 120, 80, 5),
  M(57, "SURF", "WATER", 95, 100, 15, void 0, "field move: travel over water"),
  M(58, "ICE BEAM", "ICE", 95, 100, 10, void 0, "10% freeze"),
  M(59, "BLIZZARD", "ICE", 120, 90, 5, void 0, "10% freeze; 90% accurate in Gen 1"),
  M(60, "PSYBEAM", "PSYCHIC", 65, 100, 20, void 0, "10% confuse"),
  M(61, "BUBBLEBEAM", "WATER", 65, 100, 20, void 0, "10% lower Speed"),
  M(62, "AURORA BEAM", "ICE", 65, 100, 20, void 0, "10% lower Attack"),
  M(63, "HYPER BEAM", "NORMAL", 150, 90, 5, "recharge", "must recharge unless it KOs"),
  M(64, "PECK", "FLYING", 35, 100, 35),
  M(65, "DRILL PECK", "FLYING", 80, 100, 20),
  M(66, "SUBMISSION", "FIGHTING", 80, 80, 25, "recoil", "1/4 recoil"),
  M(67, "LOW KICK", "FIGHTING", 50, 90, 20, void 0, "30% flinch"),
  M(68, "COUNTER", "FIGHTING", 0, 100, 20, "variable", "returns double physical damage taken"),
  M(69, "SEISMIC TOSS", "FIGHTING", 0, 100, 20, "fixed", "damage equals user level"),
  M(70, "STRENGTH", "NORMAL", 80, 100, 15, void 0, "field move: push boulders"),
  M(71, "ABSORB", "GRASS", 20, 100, 20, "drain", "heals half the damage dealt"),
  M(72, "MEGA DRAIN", "GRASS", 40, 100, 10, "drain", "heals half the damage dealt"),
  M(73, "LEECH SEED", "GRASS", 0, 90, 10, void 0, "drains HP each turn; fails on Grass types"),
  M(74, "GROWTH", "NORMAL", 0, null, 40, void 0, "raises Special"),
  M(75, "RAZOR LEAF", "GRASS", 55, 95, 25, void 0, "high crit rate"),
  M(76, "SOLARBEAM", "GRASS", 120, 100, 10, "two-turn", "charges one turn"),
  M(77, "POISONPOWDER", "POISON", 0, 75, 35, void 0, "poisons target"),
  M(78, "STUN SPORE", "GRASS", 0, 75, 30, void 0, "paralyzes target"),
  M(79, "SLEEP POWDER", "GRASS", 0, 75, 15, void 0, "puts target to sleep"),
  M(80, "PETAL DANCE", "GRASS", 70, 100, 20, void 0, "locks in 3-4 turns then confuses user"),
  M(81, "STRING SHOT", "BUG", 0, 95, 40, void 0, "lowers Speed"),
  M(82, "DRAGON RAGE", "DRAGON", 0, 100, 10, "fixed", "always deals exactly 40 damage"),
  M(83, "FIRE SPIN", "FIRE", 15, 70, 15, void 0, "traps the target"),
  M(84, "THUNDERSHOCK", "ELECTRIC", 40, 100, 30, void 0, "10% paralyze"),
  M(85, "THUNDERBOLT", "ELECTRIC", 95, 100, 15, void 0, "10% paralyze"),
  M(86, "THUNDER WAVE", "ELECTRIC", 0, 100, 20, void 0, "paralyzes target; no effect on Ground"),
  M(87, "THUNDER", "ELECTRIC", 120, 70, 10, void 0, "10% paralyze"),
  M(88, "ROCK THROW", "ROCK", 50, 90, 15),
  M(89, "EARTHQUAKE", "GROUND", 100, 100, 10),
  M(90, "FISSURE", "GROUND", 0, 30, 5, "ohko", "instant KO if it hits and user is faster"),
  M(91, "DIG", "GROUND", 100, 100, 10, "two-turn", "field move: escape a dungeon"),
  M(92, "TOXIC", "POISON", 0, 85, 10, void 0, "badly poisons target"),
  M(93, "CONFUSION", "PSYCHIC", 50, 100, 25, void 0, "10% confuse"),
  M(94, "PSYCHIC", "PSYCHIC", 90, 100, 10, void 0, "30% lower Special"),
  M(95, "HYPNOSIS", "PSYCHIC", 0, 60, 20, void 0, "puts target to sleep"),
  M(96, "MEDITATE", "PSYCHIC", 0, null, 40, void 0, "raises Attack"),
  M(97, "AGILITY", "PSYCHIC", 0, null, 30, void 0, "sharply raises Speed"),
  M(98, "QUICK ATTACK", "NORMAL", 40, 100, 30, void 0, "always strikes first"),
  M(99, "RAGE", "NORMAL", 20, 100, 20, void 0, "locks in, Attack rises when hit"),
  M(100, "TELEPORT", "PSYCHIC", 0, null, 20, void 0, "flees wild battles; field move: warp to last Center"),
  M(101, "NIGHT SHADE", "GHOST", 0, 100, 15, "fixed", "damage equals user level"),
  M(102, "MIMIC", "NORMAL", 0, 100, 10, void 0, "copies a target move"),
  M(103, "SCREECH", "NORMAL", 0, 85, 40, void 0, "sharply lowers Defense"),
  M(104, "DOUBLE TEAM", "NORMAL", 0, null, 15, void 0, "raises evasion"),
  M(105, "RECOVER", "NORMAL", 0, null, 20, "heal", "restores half max HP"),
  M(106, "HARDEN", "NORMAL", 0, null, 30, void 0, "raises Defense"),
  M(107, "MINIMIZE", "NORMAL", 0, null, 20, void 0, "raises evasion"),
  M(108, "SMOKESCREEN", "NORMAL", 0, 100, 20, void 0, "lowers accuracy"),
  M(109, "CONFUSE RAY", "GHOST", 0, 100, 10, void 0, "confuses target"),
  M(110, "WITHDRAW", "WATER", 0, null, 40, void 0, "raises Defense"),
  M(111, "DEFENSE CURL", "NORMAL", 0, null, 40, void 0, "raises Defense"),
  M(112, "BARRIER", "PSYCHIC", 0, null, 30, void 0, "sharply raises Defense"),
  M(113, "LIGHT SCREEN", "PSYCHIC", 0, null, 30, void 0, "halves special damage taken"),
  M(114, "HAZE", "ICE", 0, null, 30, void 0, "resets all stat changes"),
  M(115, "REFLECT", "PSYCHIC", 0, null, 20, void 0, "halves physical damage taken"),
  M(116, "FOCUS ENERGY", "NORMAL", 0, null, 30, void 0, "lowers crit rate in Gen 1 (bugged)"),
  M(117, "BIDE", "NORMAL", 0, 100, 10, "variable", "returns double damage taken over 2-3 turns"),
  M(118, "METRONOME", "NORMAL", 0, null, 10, "variable", "uses a random move"),
  M(119, "MIRROR MOVE", "FLYING", 0, null, 20, "variable", "copies the target last move"),
  M(120, "SELFDESTRUCT", "NORMAL", 130, 100, 5, void 0, "user faints"),
  M(121, "EGG BOMB", "NORMAL", 100, 75, 10),
  M(122, "LICK", "GHOST", 20, 100, 30, void 0, "30% paralyze"),
  M(123, "SMOG", "POISON", 20, 70, 20, void 0, "40% poison"),
  M(124, "SLUDGE", "POISON", 65, 100, 20, void 0, "40% poison"),
  M(125, "BONE CLUB", "GROUND", 65, 85, 20, void 0, "10% flinch"),
  M(126, "FIRE BLAST", "FIRE", 120, 85, 5, void 0, "30% burn"),
  M(127, "WATERFALL", "WATER", 80, 100, 15),
  M(128, "CLAMP", "WATER", 35, 75, 10, void 0, "traps the target"),
  M(129, "SWIFT", "NORMAL", 60, null, 20, void 0, "never misses"),
  M(130, "SKULL BASH", "NORMAL", 100, 100, 15, "two-turn", "charges one turn"),
  M(131, "SPIKE CANNON", "NORMAL", 20, 100, 15, "multi-hit", "hits 2-5 times"),
  M(132, "CONSTRICT", "NORMAL", 10, 100, 35, void 0, "10% lower Speed"),
  M(133, "AMNESIA", "PSYCHIC", 0, null, 20, void 0, "sharply raises Special (very strong in Gen 1)"),
  M(134, "KINESIS", "PSYCHIC", 0, 80, 15, void 0, "lowers accuracy"),
  M(135, "SOFTBOILED", "NORMAL", 0, null, 10, "heal", "restores half max HP"),
  M(136, "HI JUMP KICK", "FIGHTING", 85, 90, 20, void 0, "crash damage on miss"),
  M(137, "GLARE", "NORMAL", 0, 75, 30, void 0, "paralyzes target"),
  M(138, "DREAM EATER", "PSYCHIC", 100, 100, 15, "drain", "only works on a sleeping target"),
  M(139, "POISON GAS", "POISON", 0, 55, 40, void 0, "poisons target"),
  M(140, "BARRAGE", "NORMAL", 15, 85, 20, "multi-hit", "hits 2-5 times"),
  M(141, "LEECH LIFE", "BUG", 20, 100, 15, "drain", "heals half the damage dealt"),
  M(142, "LOVELY KISS", "NORMAL", 0, 75, 10, void 0, "puts target to sleep"),
  M(143, "SKY ATTACK", "FLYING", 140, 90, 5, "two-turn", "charges one turn"),
  M(144, "TRANSFORM", "NORMAL", 0, null, 10, void 0, "copies the target entirely"),
  M(145, "BUBBLE", "WATER", 20, 100, 30, void 0, "10% lower Speed"),
  M(146, "DIZZY PUNCH", "NORMAL", 70, 100, 10),
  M(147, "SPORE", "GRASS", 0, 100, 15, void 0, "always puts target to sleep"),
  M(148, "FLASH", "NORMAL", 0, 70, 20, void 0, "lowers accuracy; field move: light caves"),
  M(149, "PSYWAVE", "PSYCHIC", 0, 80, 15, "variable", "random damage up to 1.5x user level"),
  M(150, "SPLASH", "NORMAL", 0, null, 40, void 0, "does absolutely nothing"),
  M(151, "ACID ARMOR", "POISON", 0, null, 40, void 0, "sharply raises Defense"),
  M(152, "CRABHAMMER", "WATER", 90, 85, 10, void 0, "high crit rate"),
  M(153, "EXPLOSION", "NORMAL", 170, 100, 5, void 0, "user faints"),
  M(154, "FURY SWIPES", "NORMAL", 18, 80, 15, "multi-hit", "hits 2-5 times"),
  M(155, "BONEMERANG", "GROUND", 50, 90, 10, "multi-hit", "hits twice"),
  M(156, "REST", "PSYCHIC", 0, null, 10, "heal", "fully heals but sleeps two turns"),
  M(157, "ROCK SLIDE", "ROCK", 75, 90, 10),
  M(158, "HYPER FANG", "NORMAL", 80, 90, 15, void 0, "10% flinch"),
  M(159, "SHARPEN", "NORMAL", 0, null, 30, void 0, "raises Attack"),
  M(160, "CONVERSION", "NORMAL", 0, null, 30, void 0, "copies the target types"),
  M(161, "TRI ATTACK", "NORMAL", 80, 100, 10),
  M(162, "SUPER FANG", "NORMAL", 0, 90, 10, "fixed", "halves the target current HP"),
  M(163, "SLASH", "NORMAL", 70, 100, 20, void 0, "high crit rate"),
  M(164, "SUBSTITUTE", "NORMAL", 0, null, 10, void 0, "trades 1/4 max HP for a decoy"),
  M(165, "STRUGGLE", "NORMAL", 50, 100, 10, "recoil", "used automatically when all PP is gone")
];
var BY_ID = new Map(MOVES.map((m) => [m.id, m]));
function getMove(id) {
  return BY_ID.get(id);
}
function moveName(id) {
  if (id === 0) return "-";
  return BY_ID.get(id)?.name ?? `UNKNOWN_MOVE_${id}`;
}

// src/game/data/items.ts
var ITEMS = {
  1: "MASTER BALL",
  2: "ULTRA BALL",
  3: "GREAT BALL",
  4: "POKE BALL",
  5: "TOWN MAP",
  6: "BICYCLE",
  7: "SURFBOARD",
  8: "SAFARI BALL",
  9: "POKEDEX",
  10: "MOON STONE",
  11: "ANTIDOTE",
  12: "BURN HEAL",
  13: "ICE HEAL",
  14: "AWAKENING",
  15: "PARLYZ HEAL",
  16: "FULL RESTORE",
  17: "MAX POTION",
  18: "HYPER POTION",
  19: "SUPER POTION",
  20: "POTION",
  21: "BOULDERBADGE",
  22: "CASCADEBADGE",
  23: "THUNDERBADGE",
  24: "RAINBOWBADGE",
  25: "SOULBADGE",
  26: "MARSHBADGE",
  27: "VOLCANOBADGE",
  28: "EARTHBADGE",
  29: "ESCAPE ROPE",
  30: "REPEL",
  31: "OLD AMBER",
  32: "FIRE STONE",
  33: "THUNDER STONE",
  34: "WATER STONE",
  35: "HP UP",
  36: "PROTEIN",
  37: "IRON",
  38: "CARBOS",
  39: "CALCIUM",
  40: "RARE CANDY",
  41: "DOME FOSSIL",
  42: "HELIX FOSSIL",
  43: "SECRET KEY",
  45: "BIKE VOUCHER",
  46: "X ACCURACY",
  47: "LEAF STONE",
  48: "CARD KEY",
  49: "NUGGET",
  51: "POKE DOLL",
  52: "FULL HEAL",
  53: "REVIVE",
  54: "MAX REVIVE",
  55: "GUARD SPEC.",
  56: "SUPER REPEL",
  57: "MAX REPEL",
  58: "DIRE HIT",
  59: "COIN",
  60: "FRESH WATER",
  61: "SODA POP",
  62: "LEMONADE",
  63: "S.S.TICKET",
  64: "GOLD TEETH",
  65: "X ATTACK",
  66: "X DEFEND",
  67: "X SPEED",
  68: "X SPECIAL",
  69: "COIN CASE",
  70: "OAK'S PARCEL",
  71: "ITEMFINDER",
  72: "SILPH SCOPE",
  73: "POKE FLUTE",
  74: "LIFT KEY",
  75: "EXP.ALL",
  76: "OLD ROD",
  77: "GOOD ROD",
  78: "SUPER ROD",
  79: "PP UP",
  80: "ETHER",
  81: "MAX ETHER",
  82: "ELIXER",
  83: "MAX ELIXER"
};
function itemName(id) {
  const known = ITEMS[id];
  if (known) return known;
  if (id >= 196 && id <= 200) return `HM0${id - 196 + 1}`;
  if (id >= 201 && id <= 250) {
    const n = id - 201 + 1;
    return `TM${String(n).padStart(2, "0")}`;
  }
  return `ITEM_${id.toString(16).toUpperCase()}`;
}

// src/game/data/maps.ts
var MAPS = {
  0: "PALLET TOWN",
  1: "VIRIDIAN CITY",
  2: "PEWTER CITY",
  3: "CERULEAN CITY",
  4: "LAVENDER TOWN",
  5: "VERMILION CITY",
  6: "CELADON CITY",
  7: "FUCHSIA CITY",
  8: "CINNABAR ISLAND",
  9: "INDIGO PLATEAU",
  10: "SAFFRON CITY",
  12: "ROUTE 1",
  13: "ROUTE 2",
  14: "ROUTE 3",
  15: "ROUTE 4",
  16: "ROUTE 5",
  17: "ROUTE 6",
  18: "ROUTE 7",
  19: "ROUTE 8",
  20: "ROUTE 9",
  21: "ROUTE 10",
  22: "ROUTE 11",
  23: "ROUTE 12",
  24: "ROUTE 13",
  25: "ROUTE 14",
  26: "ROUTE 15",
  27: "ROUTE 16",
  28: "ROUTE 17",
  29: "ROUTE 18",
  30: "ROUTE 19",
  31: "ROUTE 20",
  32: "ROUTE 21",
  33: "ROUTE 22",
  34: "ROUTE 23",
  35: "ROUTE 24",
  36: "ROUTE 25",
  37: "REDS HOUSE 1F",
  38: "REDS HOUSE 2F",
  39: "BLUES HOUSE",
  40: "OAKS LAB",
  41: "VIRIDIAN POKECENTER",
  42: "VIRIDIAN MART",
  43: "VIRIDIAN SCHOOL",
  44: "VIRIDIAN HOUSE",
  45: "VIRIDIAN GYM",
  46: "DIGLETTS CAVE ROUTE 2",
  47: "VIRIDIAN FOREST EXIT",
  48: "ROUTE 2 HOUSE",
  49: "ROUTE 2 GATE",
  50: "VIRIDIAN FOREST ENTRANCE",
  51: "VIRIDIAN FOREST",
  52: "PEWTER MUSEUM 1F",
  53: "PEWTER MUSEUM 2F",
  54: "PEWTER GYM",
  55: "PEWTER HOUSE 1",
  56: "PEWTER MART",
  57: "PEWTER HOUSE 2",
  58: "PEWTER POKECENTER",
  59: "MT MOON 1F",
  60: "MT MOON B1F",
  61: "MT MOON B2F",
  62: "CERULEAN TRASHED HOUSE",
  63: "CERULEAN TRADE HOUSE",
  64: "CERULEAN POKECENTER",
  65: "CERULEAN GYM",
  66: "BIKE SHOP",
  67: "CERULEAN MART",
  68: "MT MOON POKECENTER",
  70: "ROUTE 5 GATE",
  71: "UNDERGROUND PATH ROUTE 5",
  72: "DAYCARE",
  73: "ROUTE 6 GATE",
  74: "UNDERGROUND PATH ROUTE 6",
  76: "ROUTE 7 GATE",
  77: "UNDERGROUND PATH ROUTE 7",
  79: "ROUTE 8 GATE",
  80: "UNDERGROUND PATH ROUTE 8",
  81: "ROCK TUNNEL POKECENTER",
  82: "ROCK TUNNEL 1F",
  83: "POWER PLANT",
  84: "ROUTE 11 GATE 1F",
  85: "DIGLETTS CAVE ROUTE 11",
  86: "ROUTE 11 GATE 2F",
  87: "ROUTE 12 GATE 1F",
  88: "BILLS HOUSE",
  89: "VERMILION POKECENTER",
  90: "POKEMON FAN CLUB",
  91: "VERMILION MART",
  92: "VERMILION GYM",
  93: "VERMILION HOUSE 1",
  94: "VERMILION DOCK",
  95: "SS ANNE 1F",
  96: "SS ANNE 2F",
  97: "SS ANNE B1F",
  98: "SS ANNE BOW",
  99: "SS ANNE KITCHEN",
  100: "SS ANNE CAPTAIN",
  101: "SS ANNE 1F ROOMS",
  102: "SS ANNE 2F ROOMS",
  104: "VICTORY ROAD 1F",
  107: "LANCE",
  108: "HALL OF FAME",
  109: "UNDERGROUND PATH NS",
  110: "CHAMPIONS ROOM",
  111: "UNDERGROUND PATH WE",
  112: "CELADON MART 1F",
  113: "CELADON MART 2F",
  114: "CELADON MART 3F",
  115: "CELADON MART 4F",
  116: "CELADON MART ROOF",
  117: "CELADON MART ELEVATOR",
  118: "CELADON MANSION 1F",
  119: "CELADON MANSION 2F",
  120: "CELADON MANSION 3F",
  121: "CELADON MANSION ROOF",
  122: "CELADON MANSION ROOF HOUSE",
  123: "CELADON POKECENTER",
  124: "CELADON GYM",
  125: "GAME CORNER",
  126: "CELADON MART 5F",
  127: "GAME CORNER PRIZE ROOM",
  128: "CELADON DINER",
  129: "CELADON HOUSE",
  130: "CELADON HOTEL",
  131: "LAVENDER POKECENTER",
  132: "POKEMON TOWER 1F",
  133: "POKEMON TOWER 2F",
  134: "POKEMON TOWER 3F",
  135: "POKEMON TOWER 4F",
  136: "POKEMON TOWER 5F",
  137: "POKEMON TOWER 6F",
  138: "POKEMON TOWER 7F",
  139: "LAVENDER HOUSE 1",
  140: "LAVENDER MART",
  141: "LAVENDER HOUSE 2",
  142: "FUCHSIA MART",
  143: "FUCHSIA HOUSE 1",
  144: "FUCHSIA POKECENTER",
  145: "FUCHSIA HOUSE 2",
  146: "SAFARI ZONE ENTRANCE",
  147: "FUCHSIA GYM",
  148: "FUCHSIA MEETING ROOM",
  149: "SEAFOAM ISLANDS B1F",
  150: "SEAFOAM ISLANDS B2F",
  151: "SEAFOAM ISLANDS B3F",
  152: "SEAFOAM ISLANDS B4F",
  153: "VERMILION HOUSE 2",
  154: "FUCHSIA HOUSE 3",
  155: "MANSION 1F",
  165: "CINNABAR GYM",
  166: "CINNABAR LAB 1",
  167: "CINNABAR LAB 2",
  168: "CINNABAR LAB 3",
  169: "CINNABAR LAB 4",
  170: "CINNABAR POKECENTER",
  171: "CINNABAR MART",
  172: "INDIGO PLATEAU LOBBY",
  173: "COPYCATS HOUSE 1F",
  174: "COPYCATS HOUSE 2F",
  175: "FIGHTING DOJO",
  176: "SAFFRON GYM",
  177: "SAFFRON HOUSE 1",
  178: "SAFFRON MART",
  179: "SILPH CO 1F",
  180: "SAFFRON POKECENTER",
  181: "SAFFRON HOUSE 2",
  182: "ROUTE 15 GATE 1F",
  192: "ROCK TUNNEL B1F",
  193: "SEAFOAM ISLANDS 1F",
  194: "SS ANNE 3F",
  197: "MANSION 2F",
  198: "MANSION 3F",
  199: "MANSION B1F",
  200: "VICTORY ROAD 2F",
  201: "VICTORY ROAD 3F",
  202: "ROCKET HIDEOUT B1F",
  203: "ROCKET HIDEOUT B2F",
  204: "ROCKET HIDEOUT B3F",
  205: "ROCKET HIDEOUT B4F",
  206: "ROCKET HIDEOUT ELEVATOR",
  210: "SILPH CO 2F",
  211: "SILPH CO 3F",
  212: "SILPH CO 4F",
  213: "SILPH CO 5F",
  214: "SILPH CO 6F",
  215: "SILPH CO 7F",
  216: "SILPH CO 8F",
  217: "POKEMON TOWER 8F",
  226: "DIGLETTS CAVE",
  227: "VICTORY ROAD 1F ALT",
  230: "SILPH CO 9F",
  231: "SILPH CO 10F",
  232: "SILPH CO 11F",
  233: "SILPH CO ELEVATOR",
  236: "TRADE CENTER",
  237: "COLOSSEUM",
  241: "LORELEI",
  242: "BRUNO",
  243: "AGATHA"
};
function mapName(id) {
  return MAPS[id] ?? `MAP_0x${id.toString(16).toUpperCase().padStart(2, "0")}`;
}

// src/game/screen.ts
function readScreenText(gb) {
  const tiles = gb.readRange(ADDR.TILE_MAP, ADDR.TILE_MAP_WIDTH * ADDR.TILE_MAP_HEIGHT);
  const rows = [];
  let cursorRow = -1;
  let cursorCol = -1;
  let awaitingInput = false;
  for (let y = 0; y < ADDR.TILE_MAP_HEIGHT; y++) {
    let row = "";
    for (let x = 0; x < ADDR.TILE_MAP_WIDTH; x++) {
      const tile = tiles[y * ADDR.TILE_MAP_WIDTH + x] ?? 0;
      if (tile === MENU_CURSOR_TILE && cursorRow === -1) {
        cursorRow = y;
        cursorCol = x;
      }
      if (tile === TEXT_PROMPT_TILE) awaitingInput = true;
      row += decodeChar(tile);
    }
    rows.push(row.replace(/\s+$/, ""));
  }
  return { rows, flat: rows.join("\n"), cursorRow, cursorCol, awaitingInput };
}
function screenHas(screen, needle) {
  return screen.flat.toUpperCase().includes(needle.toUpperCase());
}
function isBattleMenu(screen) {
  return screenHas(screen, "FIGHT") && screenHas(screen, "RUN");
}
function isMoveMenu(screen) {
  return screenHas(screen, "TYPE/") || screenHas(screen, "PP") && !isBattleMenu(screen);
}
function nonEmptyLines(screen) {
  return screen.rows.filter((row) => row.trim().length > 0);
}

// src/game/state.ts
var NEUTRAL_STAGE = 7;
function readMoveSlots(gb, movesAddr, ppAddr) {
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const id = gb.readByte(movesAddr + i);
    if (id === 0) continue;
    const data = getMove(id);
    slots.push({
      index: i,
      id,
      name: moveName(id),
      type: data?.type ?? "UNKNOWN",
      power: data?.power ?? 0,
      accuracy: data?.accuracy ?? null,
      // The top two bits of the PP byte are PP Up counters, not PP.
      pp: gb.readByte(ppAddr + i) & 63,
      ...data?.special ? { special: data.special } : {},
      ...data?.note ? { note: data.note } : {}
    });
  }
  return slots;
}
function stagesFrom(gb, base) {
  const [atk, def, spe, spc, acc, eva] = base;
  const toStage = (addr) => addr === void 0 ? 0 : gb.readByte(addr) - NEUTRAL_STAGE;
  return {
    attack: toStage(atk),
    defense: toStage(def),
    speed: toStage(spe),
    special: toStage(spc),
    accuracy: toStage(acc),
    evasion: toStage(eva)
  };
}
function percent(hp, maxHp) {
  return maxHp > 0 ? Math.round(hp / maxHp * 100) : 0;
}
function readParty(gb) {
  const count = Math.min(gb.readByte(ADDR.wPartyCount), 6);
  const party = [];
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
        special: gb.readWord(base + f.special)
      },
      fainted: hp === 0
    });
  }
  return party;
}
function readBag(gb) {
  const count = Math.min(gb.readByte(ADDR.wNumBagItems), 20);
  const bytes = gb.readRange(ADDR.wBagItems, count * 2);
  const bag = [];
  for (let i = 0; i < count; i++) {
    const id = bytes[i * 2];
    const qty = bytes[i * 2 + 1];
    if (id === void 0 || id === 255) break;
    bag.push({ item: itemName(id), count: qty ?? 0 });
  }
  return bag;
}
function readMoney(gb) {
  const bytes = gb.readRange(ADDR.wPlayerMoney, 3);
  let value = 0;
  for (const byte of bytes) {
    value = value * 100 + (byte >> 4) * 10 + (byte & 15);
  }
  return value;
}
function readBattle(gb, party) {
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
  const variant = battleType === 1 ? "old-man-tutorial" : battleType === 2 ? "safari" : "normal";
  const player = {
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
      special: gb.readWord(B.special)
    },
    fainted: playerHp === 0,
    statStages: stagesFrom(gb, [
      ADDR.wPlayerMonAttackMod,
      ADDR.wPlayerMonDefenseMod,
      ADDR.wPlayerMonSpeedMod,
      ADDR.wPlayerMonSpecialMod,
      ADDR.wPlayerMonAccuracyMod,
      ADDR.wPlayerMonEvasionMod
    ])
  };
  const enemy = {
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
      special: gb.readWord(E.special)
    },
    fainted: enemyHp === 0,
    statStages: stagesFrom(gb, [
      ADDR.wEnemyMonAttackMod,
      ADDR.wEnemyMonDefenseMod,
      ADDR.wEnemyMonSpeedMod,
      ADDR.wEnemyMonSpecialMod,
      ADDR.wEnemyMonAccuracyMod,
      ADDR.wEnemyMonEvasionMod
    ])
  };
  const partyEntry = party[partyPos];
  if (partyEntry && player.species === partyEntry.species && player.maxHp === 0) {
    player.hp = partyEntry.hp;
    player.maxHp = partyEntry.maxHp;
    player.hpPercent = partyEntry.hpPercent;
  }
  return {
    kind: inBattle === 2 ? "trainer" : "wild",
    variant,
    player,
    enemy
  };
}
function readGameState(gb) {
  const screen = readScreenText(gb);
  const party = readParty(gb);
  const battle = readBattle(gb, party);
  return {
    frame: gb.frameCount,
    mode: battle ? "battle" : "overworld",
    screen,
    menu: {
      cursorIndex: gb.readByte(ADDR.wCurrentMenuItem),
      maxItem: gb.readByte(ADDR.wMaxMenuItem)
    },
    ui: {
      battleMenuOpen: battle !== null && isBattleMenu(screen),
      moveMenuOpen: battle !== null && isMoveMenu(screen) && !isBattleMenu(screen),
      awaitingTextInput: screen.awaitingInput
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
      bag: readBag(gb)
    }
  };
}

// src/harness/events.ts
function buildStateEvent(state, analysis) {
  return {
    frame: state.frame,
    mode: state.mode,
    location: state.world.mapName,
    position: { x: state.world.x, y: state.world.y },
    money: state.world.money,
    badges: state.world.badges,
    party: state.world.party.map((mon) => ({
      name: mon.nickname || mon.species,
      species: mon.species,
      level: mon.level,
      hp: mon.hp,
      maxHp: mon.maxHp,
      hpPercent: mon.hpPercent,
      status: mon.status
    })),
    screen: nonEmptyLines(state.screen),
    battle: state.battle ? {
      kind: state.battle.kind,
      enemy: state.battle.enemy.species,
      enemyLevel: state.battle.enemy.level,
      enemyHpPercent: state.battle.enemy.hpPercent,
      active: state.battle.player.nickname || state.battle.player.species,
      activeHpPercent: state.battle.player.hpPercent,
      analysis
    } : null
  };
}

// src/game/battle.ts
var STAGE_MULTIPLIERS = [0.25, 0.28, 0.33, 0.4, 0.5, 0.66, 1, 1.5, 2, 2.5, 3, 3.5, 4];
function stageMultiplier(stage) {
  const clamped = Math.max(-6, Math.min(6, stage));
  return STAGE_MULTIPLIERS[clamped + 6] ?? 1;
}
function typeId(name) {
  return name === "UNKNOWN" ? TYPE_IDS.NORMAL : TYPE_IDS[name];
}
function estimateDamage(params) {
  const { level, attack, defense, power, stab, typeMultiplier: typeMultiplier2, targetHp } = params;
  if (power <= 0 || typeMultiplier2 === 0 || defense <= 0) {
    return { min: 0, max: 0, typical: 0, fractionOfTargetHp: 0 };
  }
  let base = Math.floor(Math.floor((Math.floor(2 * level / 5) + 2) * attack * power) / defense);
  base = Math.floor(base / 50) + 2;
  if (stab) base = Math.floor(base * 1.5);
  base = Math.floor(base * typeMultiplier2);
  const min = Math.max(1, Math.floor(base * 217 / 255));
  const max = Math.max(1, base);
  const typical = Math.floor((min + max) / 2);
  return {
    min,
    max,
    typical,
    fractionOfTargetHp: targetHp > 0 ? Math.min(1, typical / targetHp) : 0
  };
}
function effectiveStat(base, stage, halved = false) {
  const value = Math.floor(base * stageMultiplier(stage));
  return Math.max(1, halved ? Math.floor(value / 2) : value);
}
function analyzeMove(move, attacker, defender) {
  const data = getMove(move.id);
  const moveTypeId = typeId(move.type);
  const mult = effectiveness(moveTypeId, typeId(defender.types[0] ?? "UNKNOWN"), typeId(defender.types[1] ?? "UNKNOWN"));
  const stab = attacker.types.includes(move.type);
  const special = isSpecialType(moveTypeId);
  const notes = [];
  if (data?.note) notes.push(data.note);
  const burned = attacker.status.includes("burned");
  const attackStat = special ? effectiveStat(attacker.stats?.special ?? 1, attacker.statStages.special) : effectiveStat(attacker.stats?.attack ?? 1, attacker.statStages.attack, burned);
  const defenseStat = special ? effectiveStat(defender.stats?.special ?? 1, defender.statStages.special) : effectiveStat(defender.stats?.defense ?? 1, defender.statStages.defense);
  if (burned && !special) notes.push("burn is halving this Attack");
  let damage = estimateDamage({
    level: attacker.level,
    attack: attackStat,
    defense: defenseStat,
    power: move.power,
    stab,
    typeMultiplier: mult,
    targetHp: defender.hp
  });
  if (data?.special === "fixed") {
    const fixed = move.id === 49 ? 20 : move.id === 82 ? 40 : move.id === 162 ? Math.floor(defender.hp / 2) : attacker.level;
    const applies = mult > 0;
    damage = {
      min: applies ? fixed : 0,
      max: applies ? fixed : 0,
      typical: applies ? fixed : 0,
      fractionOfTargetHp: defender.hp > 0 && applies ? Math.min(1, fixed / defender.hp) : 0
    };
    notes.push("fixed damage, ignores stats and type effectiveness (but not immunity)");
  }
  if (data?.special === "ohko") {
    const faster = (attacker.stats?.speed ?? 0) >= (defender.stats?.speed ?? 0);
    notes.push(faster ? "OHKO move: instant KO if it hits" : "OHKO move fails: the target is faster");
  }
  if (data?.special === "two-turn") notes.push("takes a turn to charge, leaving you open");
  if (data?.special === "recharge") notes.push("locks you into a recharge turn unless it KOs");
  if (data?.special === "multi-hit") notes.push("damage shown is per hit; it hits multiple times");
  if (mult === 0) notes.push(`${defender.species} is immune to ${move.type}`);
  if (move.pp === 0) notes.push("no PP left \u2014 this move cannot be selected");
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
    notes
  };
}
function analyzeBattle(battle, party, options = {}) {
  const { player, enemy } = battle;
  const moves = player.moves.map((move) => analyzeMove(move, player, enemy)).sort((a, b) => b.score - a.score);
  const paralyzed = (side) => side.status.includes("paralyzed") ? 4 : 1;
  const playerSpeed = Math.floor(
    effectiveStat(player.stats?.speed ?? 1, player.statStages.speed) / paralyzed(player)
  );
  const enemySpeed = Math.floor(
    effectiveStat(enemy.stats?.speed ?? 1, enemy.statStages.speed) / paralyzed(enemy)
  );
  const incoming = options.fairPlay ? [] : enemy.moves.filter((move) => move.power > 0).map((move) => {
    const analysis = analyzeMove(move, enemy, player);
    return {
      move: move.name,
      type: move.type,
      effectiveness: analysis.effectiveness,
      damage: analysis.damage,
      canKo: analysis.possibleKo
    };
  }).sort((a, b) => b.damage.typical - a.damage.typical);
  const worstIncoming = incoming[0]?.damage.typical ?? 0;
  const inKoRange = incoming.some((threat) => threat.canKo);
  const turnsToSurvive = worstIncoming > 0 ? Math.ceil(player.hp / worstIncoming) : Infinity;
  const switchOptions = party.filter((mon) => !mon.fainted && mon.slot !== player.slot).map((mon) => ({
    slot: mon.slot,
    name: mon.nickname || mon.species,
    hpPercent: mon.hpPercent,
    note: `${mon.species} (${mon.types.filter((t) => t !== "UNKNOWN").join("/")})`
  })).sort((a, b) => b.hpPercent - a.hpPercent);
  const catchChance = battle.kind === "wild" ? estimateCatchChance(enemy, "POKE BALL") : null;
  const best = moves[0];
  const summaryParts = [
    `${player.nickname || player.species} L${player.level} ${player.hp}/${player.maxHp} HP vs ${enemy.species} L${enemy.level} ${enemy.hp}/${enemy.maxHp} HP.`,
    `${playerSpeed >= enemySpeed ? "You move first" : "The opponent moves first"} (speed ${playerSpeed} vs ${enemySpeed}).`
  ];
  if (best) {
    summaryParts.push(
      `Best expected move: ${best.name} (${best.effectivenessLabel}, ~${best.damage.typical} damage${best.guaranteedKo ? ", guaranteed KO" : best.possibleKo ? ", can KO" : ""}).`
    );
  }
  if (inKoRange) summaryParts.push("WARNING: the opponent can knock you out this turn.");
  return {
    moves,
    fasterSide: playerSpeed === enemySpeed ? "tie" : playerSpeed > enemySpeed ? "player" : "enemy",
    playerSpeed,
    enemySpeed,
    incoming,
    inKoRange,
    turnsToSurvive,
    switchOptions,
    catchChance,
    summary: summaryParts.join(" ")
  };
}
var BALL_FACTORS = {
  "POKE BALL": { ball: 255, hp: 8 },
  "GREAT BALL": { ball: 200, hp: 12 },
  "ULTRA BALL": { ball: 150, hp: 8 },
  "SAFARI BALL": { ball: 150, hp: 8 }
};
function estimateCatchChance(enemy, ball, catchRate = 45) {
  if (ball === "MASTER BALL") return 1;
  const factors = BALL_FACTORS[ball] ?? BALL_FACTORS["POKE BALL"];
  if (enemy.maxHp <= 0) return 0;
  const statusBonus = /asleep|frozen/.test(enemy.status) ? 25 : /poisoned|burned|paralyzed/.test(enemy.status) ? 12 : 0;
  const firstCheck = Math.min(1, (catchRate + statusBonus) / factors.ball);
  let maxHp = enemy.maxHp * 4;
  let currentHp = Math.max(1, enemy.hp) * factors.hp;
  if (maxHp > 255) {
    maxHp = Math.max(1, maxHp >> 2);
    currentHp = Math.max(1, currentHp >> 2);
  }
  const f = Math.min(255, Math.floor(maxHp * 255 / currentHp));
  const secondCheck = Math.min(1, (f + 1) / 256);
  return Number((firstCheck * secondCheck).toFixed(3));
}

// src/jev/battle-agent.ts
import { generateObject } from "ai";
import { z } from "zod";

// src/jev/model.ts
import { createGateway } from "@ai-sdk/gateway";
var DEFAULT_MODEL = "anthropic/claude-sonnet-5";
var DEFAULT_BATTLE_MODEL = "anthropic/claude-opus-5";
function loadConfig(overrides = {}) {
  const fallbacks = (process.env.JEV_FALLBACK_MODELS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return {
    model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
    battleModel: process.env.JEV_BATTLE_MODEL ?? process.env.JEV_MODEL ?? DEFAULT_BATTLE_MODEL,
    fallbacks,
    vision: process.env.JEV_VISION !== "false",
    fairPlay: process.env.JEV_FAIR_PLAY === "true",
    offline: false,
    temperature: process.env.JEV_TEMPERATURE ? Number(process.env.JEV_TEMPERATURE) : void 0,
    ...overrides
  };
}

// src/jev/battle-agent.ts
var BattleDecisionSchema = z.object({
  reasoning: z.string().describe("One or two sentences: why this is the right action this turn."),
  action: z.enum(["fight", "switch", "item", "run"]).describe("What to do this turn."),
  moveIndex: z.number().int().min(0).max(3).nullable().describe('Which move slot to use when action is "fight". Null otherwise.'),
  partySlot: z.number().int().min(0).max(5).nullable().describe('Which party slot to switch to when action is "switch". Null otherwise.'),
  item: z.string().nullable().describe('Exact bag item name when action is "item" (e.g. "POTION", "POKE BALL"). Null otherwise.'),
  noteToSelf: z.string().nullable().describe("Something worth remembering for later in the run, or null.")
});

// src/jev/overworld-agent.ts
import { generateObject as generateObject2 } from "ai";
import { z as z2 } from "zod";
var ButtonPlanSchema = z2.object({
  observation: z2.string().describe("What is happening on screen right now, in one sentence."),
  goal: z2.string().describe("The objective you are working towards. Keep the previous goal unless it is done."),
  inputs: z2.array(
    z2.object({
      button: z2.enum(BUTTONS),
      repeat: z2.number().int().min(1).max(12).describe("How many times to press it (e.g. walking several tiles).")
    })
  ).min(1).max(6).describe("The button presses to perform now. Keep it short \u2014 you will see the result and can continue."),
  noteToSelf: z2.string().nullable().describe("A durable fact worth remembering (a location, a blocked path, an NPC), or null.")
});

// src/harness/turn.ts
function analyzeIfBattle(state, config) {
  if (!state.battle) return null;
  return analyzeBattle(state.battle, state.world.party, { fairPlay: config.fairPlay });
}

// server/_lib/engine.ts
var INITIAL_STRIDE = 2 * Math.max(1, Math.min(20, Number(process.env.JEV_SPEED ?? 4)));
var MAX_FRAMES = 240;
var FrameRecorder = class {
  #frames = [];
  #counter = 0;
  #stride = INITIAL_STRIDE;
  attach(gb) {
    gb.onFrame = (emulator) => {
      this.#counter++;
      if (this.#counter % this.#stride !== 0) return;
      this.#frames.push(screenToPng(emulator.screen(), 1).toString("base64"));
      if (this.#frames.length >= MAX_FRAMES) {
        this.#frames = this.#frames.filter((_, index) => index % 2 === 0);
        this.#stride *= 2;
      }
    };
  }
  /** How many emulated frames each captured frame now represents. */
  get stride() {
    return this.#stride;
  }
  detach(gb) {
    gb.onFrame = null;
  }
  /** Always ends on the current screen, even if the cap was hit mid-action. */
  finish(gb) {
    this.detach(gb);
    this.#frames.push(screenToPng(gb.screen(), 1).toString("base64"));
    return this.#frames;
  }
};
function describe(gb, journal, turns, config) {
  const state = readGameState(gb);
  return {
    state: buildStateEvent(state, analyzeIfBattle(state, config)),
    journal: {
      goal: journal.goal,
      notes: journal.notes,
      stats: journal.stats
    },
    turns
  };
}

// server/_lib/http.ts
var JSON_HEADERS = {
  "content-type": "application/json",
  // Every response reflects a mutating tick; caching any of it would desync
  // the browser from the emulator.
  "cache-control": "no-store"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function fail(error, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, status);
}
function sessionIdFrom(request) {
  const id = new URL(request.url).searchParams.get("session") ?? "default";
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : "default";
}

// server/state.ts
async function GET(request) {
  try {
    const sessionId = sessionIdFrom(request);
    const jevConfig = loadConfig();
    const { gb, journal, turns, isNew } = await openSession(sessionId);
    if (isNew) await saveSession(sessionId, gb, journal, turns);
    const recorder = new FrameRecorder();
    return json({
      ...describe(gb, journal, turns, jevConfig),
      isNew,
      frames: recorder.finish(gb),
      models: { overworld: jevConfig.model, battle: jevConfig.battleModel }
    });
  } catch (error) {
    return fail(error);
  }
}
export {
  GET
};
