/**
 * Gen 1 internal species indices.
 *
 * Red stores an internal index, NOT the Pokedex number, so Rhydon is 0x01 and
 * Bulbasaur is 0x99. The gaps are the infamous MissingNo. slots.
 */
const INTERNAL: Record<number, string> = {
  0x01: 'RHYDON', 0x02: 'KANGASKHAN', 0x03: 'NIDORAN_M', 0x04: 'CLEFAIRY',
  0x05: 'SPEAROW', 0x06: 'VOLTORB', 0x07: 'NIDOKING', 0x08: 'SLOWBRO',
  0x09: 'IVYSAUR', 0x0a: 'EXEGGUTOR', 0x0b: 'LICKITUNG', 0x0c: 'EXEGGCUTE',
  0x0d: 'GRIMER', 0x0e: 'GENGAR', 0x0f: 'NIDORAN_F', 0x10: 'NIDOQUEEN',
  0x11: 'CUBONE', 0x12: 'RHYHORN', 0x13: 'LAPRAS', 0x14: 'ARCANINE',
  0x15: 'MEW', 0x16: 'GYARADOS', 0x17: 'SHELLDER', 0x18: 'TENTACOOL',
  0x19: 'GASTLY', 0x1a: 'SCYTHER', 0x1b: 'STARYU', 0x1c: 'BLASTOISE',
  0x1d: 'PINSIR', 0x1e: 'TANGELA',
  0x21: 'GROWLITHE', 0x22: 'ONIX', 0x23: 'FEAROW', 0x24: 'PIDGEY',
  0x25: 'SLOWPOKE', 0x26: 'KADABRA', 0x27: 'GRAVELER', 0x28: 'CHANSEY',
  0x29: 'MACHOKE', 0x2a: 'MR_MIME', 0x2b: 'HITMONLEE', 0x2c: 'HITMONCHAN',
  0x2d: 'ARBOK', 0x2e: 'PARASECT', 0x2f: 'PSYDUCK', 0x30: 'DROWZEE',
  0x31: 'GOLEM',
  0x33: 'MAGMAR',
  0x35: 'ELECTABUZZ', 0x36: 'MAGNETON', 0x37: 'KOFFING',
  0x39: 'MANKEY', 0x3a: 'SEEL', 0x3b: 'DIGLETT', 0x3c: 'TAUROS',
  0x40: 'FARFETCHD', 0x41: 'VENONAT', 0x42: 'DRAGONITE',
  0x46: 'DODUO', 0x47: 'POLIWAG', 0x48: 'JYNX', 0x49: 'MOLTRES',
  0x4a: 'ARTICUNO', 0x4b: 'ZAPDOS', 0x4c: 'DITTO', 0x4d: 'MEOWTH',
  0x4e: 'KRABBY',
  0x52: 'VULPIX', 0x53: 'NINETALES', 0x54: 'PIKACHU', 0x55: 'RAICHU',
  0x58: 'DRATINI', 0x59: 'DRAGONAIR', 0x5a: 'KABUTO', 0x5b: 'KABUTOPS',
  0x5c: 'HORSEA', 0x5d: 'SEADRA',
  0x60: 'SANDSHREW', 0x61: 'SANDSLASH', 0x62: 'OMANYTE', 0x63: 'OMASTAR',
  0x64: 'JIGGLYPUFF', 0x65: 'WIGGLYTUFF', 0x66: 'EEVEE', 0x67: 'FLAREON',
  0x68: 'JOLTEON', 0x69: 'VAPOREON', 0x6a: 'MACHOP', 0x6b: 'ZUBAT',
  0x6c: 'EKANS', 0x6d: 'PARAS', 0x6e: 'POLIWHIRL', 0x6f: 'POLIWRATH',
  0x70: 'WEEDLE', 0x71: 'KAKUNA', 0x72: 'BEEDRILL',
  0x74: 'DODRIO', 0x75: 'PRIMEAPE', 0x76: 'DUGTRIO', 0x77: 'VENOMOTH',
  0x78: 'DEWGONG',
  0x7b: 'CATERPIE', 0x7c: 'METAPOD', 0x7d: 'BUTTERFREE', 0x7e: 'MACHAMP',
  0x80: 'GOLDUCK', 0x81: 'HYPNO', 0x82: 'GOLBAT', 0x83: 'MEWTWO',
  0x84: 'SNORLAX', 0x85: 'MAGIKARP',
  0x88: 'MUK',
  0x8a: 'KINGLER', 0x8b: 'CLOYSTER',
  0x8d: 'ELECTRODE', 0x8e: 'CLEFABLE', 0x8f: 'WEEZING',
  0x90: 'PERSIAN', 0x91: 'MAROWAK',
  0x93: 'HAUNTER', 0x94: 'ABRA', 0x95: 'ALAKAZAM', 0x96: 'PIDGEOTTO',
  0x97: 'PIDGEOT', 0x98: 'STARMIE', 0x99: 'BULBASAUR', 0x9a: 'VENUSAUR',
  0x9b: 'TENTACRUEL',
  0x9d: 'GOLDEEN', 0x9e: 'SEAKING',
  0xa3: 'PONYTA', 0xa4: 'RAPIDASH', 0xa5: 'RATTATA', 0xa6: 'RATICATE',
  0xa7: 'NIDORINO', 0xa8: 'NIDORINA', 0xa9: 'GEODUDE', 0xaa: 'PORYGON',
  0xab: 'AERODACTYL',
  0xad: 'MAGNEMITE',
  0xb0: 'CHARMANDER', 0xb1: 'SQUIRTLE', 0xb2: 'CHARMELEON', 0xb3: 'WARTORTLE',
  0xb4: 'CHARIZARD',
  0xb9: 'ODDISH', 0xba: 'GLOOM', 0xbb: 'VILEPLUME', 0xbc: 'BELLSPROUT',
  0xbd: 'WEEPINBELL', 0xbe: 'VICTREEBEL',
};

/** Pretty display names for the few species whose constant name is awkward. */
const DISPLAY: Record<string, string> = {
  NIDORAN_M: 'NIDORAN-M',
  NIDORAN_F: 'NIDORAN-F',
  MR_MIME: 'MR.MIME',
  FARFETCHD: "FARFETCH'D",
};

export function speciesName(internalId: number): string {
  const raw = INTERNAL[internalId];
  if (!raw) return internalId === 0 ? 'NONE' : `MISSINGNO_${internalId.toString(16).toUpperCase()}`;
  return DISPLAY[raw] ?? raw;
}

export const SPECIES_COUNT = Object.keys(INTERNAL).length;
