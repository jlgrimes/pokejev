/** Gen 1 item ids as stored in the bag (0xC4+ are the HMs and TMs). */
const ITEMS: Record<number, string> = {
  0x01: 'MASTER BALL', 0x02: 'ULTRA BALL', 0x03: 'GREAT BALL', 0x04: 'POKE BALL',
  0x05: 'TOWN MAP', 0x06: 'BICYCLE', 0x07: 'SURFBOARD', 0x08: 'SAFARI BALL',
  0x09: 'POKEDEX', 0x0a: 'MOON STONE', 0x0b: 'ANTIDOTE', 0x0c: 'BURN HEAL',
  0x0d: 'ICE HEAL', 0x0e: 'AWAKENING', 0x0f: 'PARLYZ HEAL', 0x10: 'FULL RESTORE',
  0x11: 'MAX POTION', 0x12: 'HYPER POTION', 0x13: 'SUPER POTION', 0x14: 'POTION',
  0x15: 'BOULDERBADGE', 0x16: 'CASCADEBADGE', 0x17: 'THUNDERBADGE', 0x18: 'RAINBOWBADGE',
  0x19: 'SOULBADGE', 0x1a: 'MARSHBADGE', 0x1b: 'VOLCANOBADGE', 0x1c: 'EARTHBADGE',
  0x1d: 'ESCAPE ROPE', 0x1e: 'REPEL', 0x1f: 'OLD AMBER', 0x20: 'FIRE STONE',
  0x21: 'THUNDER STONE', 0x22: 'WATER STONE', 0x23: 'HP UP', 0x24: 'PROTEIN',
  0x25: 'IRON', 0x26: 'CARBOS', 0x27: 'CALCIUM', 0x28: 'RARE CANDY',
  0x29: 'DOME FOSSIL', 0x2a: 'HELIX FOSSIL', 0x2b: 'SECRET KEY',
  0x2d: 'BIKE VOUCHER', 0x2e: 'X ACCURACY', 0x2f: 'LEAF STONE', 0x30: 'CARD KEY',
  0x31: 'NUGGET', 0x33: 'POKE DOLL', 0x34: 'FULL HEAL', 0x35: 'REVIVE',
  0x36: 'MAX REVIVE', 0x37: 'GUARD SPEC.', 0x38: 'SUPER REPEL', 0x39: 'MAX REPEL',
  0x3a: 'DIRE HIT', 0x3b: 'COIN', 0x3c: 'FRESH WATER', 0x3d: 'SODA POP',
  0x3e: 'LEMONADE', 0x3f: 'S.S.TICKET', 0x40: 'GOLD TEETH', 0x41: 'X ATTACK',
  0x42: 'X DEFEND', 0x43: 'X SPEED', 0x44: 'X SPECIAL', 0x45: 'COIN CASE',
  0x46: "OAK'S PARCEL", 0x47: 'ITEMFINDER', 0x48: 'SILPH SCOPE', 0x49: 'POKE FLUTE',
  0x4a: 'LIFT KEY', 0x4b: 'EXP.ALL', 0x4c: 'OLD ROD', 0x4d: 'GOOD ROD',
  0x4e: 'SUPER ROD', 0x4f: 'PP UP', 0x50: 'ETHER', 0x51: 'MAX ETHER',
  0x52: 'ELIXER', 0x53: 'MAX ELIXER',
};

export function itemName(id: number): string {
  const known = ITEMS[id];
  if (known) return known;
  if (id >= 0xc4 && id <= 0xc8) return `HM0${id - 0xc4 + 1}`;
  if (id >= 0xc9 && id <= 0xfa) {
    const n = id - 0xc9 + 1;
    return `TM${String(n).padStart(2, '0')}`;
  }
  return `ITEM_${id.toString(16).toUpperCase()}`;
}

/** Items Jev may use from the bag during a battle, with a hint about each. */
export const BATTLE_ITEMS: Record<string, string> = {
  POTION: 'restores 20 HP',
  'SUPER POTION': 'restores 50 HP',
  'HYPER POTION': 'restores 200 HP',
  'MAX POTION': 'fully restores HP',
  'FULL RESTORE': 'fully restores HP and cures status',
  ANTIDOTE: 'cures poison',
  'PARLYZ HEAL': 'cures paralysis',
  AWAKENING: 'cures sleep',
  'BURN HEAL': 'cures burn',
  'ICE HEAL': 'cures freeze',
  'FULL HEAL': 'cures any status',
  REVIVE: 'revives a fainted Pokemon to half HP',
  'POKE BALL': 'catches a weakened wild Pokemon',
  'GREAT BALL': 'better catch rate',
  'ULTRA BALL': 'best normal catch rate',
  'POKE DOLL': 'guarantees escape from a wild battle',
  'X ATTACK': 'raises Attack for the battle',
  'X SPECIAL': 'raises Special for the battle',
};
