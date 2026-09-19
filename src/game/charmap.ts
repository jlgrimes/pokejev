/**
 * Pokemon Red's text encoding.
 *
 * The same codes appear in two places we care about: strings stored in RAM
 * (names, terminated by 0x50) and the on-screen tilemap at 0xC3A0, because the
 * font tiles are loaded at exactly these indices. That means decoding the
 * tilemap gives us the literal text on screen — far more reliable than trying
 * to OCR the framebuffer.
 */
const TABLE: Record<number, string> = {
  0x4a: 'PKMN',
  0x4e: '\n', // line break within a text box
  0x4f: '\n',
  0x50: '', // string terminator
  0x51: '\n', // paragraph break
  0x55: '\n',
  0x57: '', // end of text
  0x58: '', // prompt
  0x5f: '', // end of dex entry
  0x7f: ' ',
  0x9a: '(', 0x9b: ')', 0x9c: ':', 0x9d: ';', 0x9e: '[', 0x9f: ']',
  0xba: 'é', 0xbb: "'d", 0xbc: "'l", 0xbd: "'s", 0xbe: "'t", 0xbf: "'v",
  0xe0: "'", 0xe1: 'PK', 0xe2: 'MN', 0xe3: '-', 0xe4: "'r", 0xe5: "'m",
  0xe6: '?', 0xe7: '!', 0xe8: '.',
  0xed: '▶', // the menu cursor arrow
  0xee: '▼', // "press A to continue" arrow
  0xef: '♂', // male symbol
  0xf0: '¥', 0xf1: '×', 0xf2: '.', 0xf3: '/', 0xf4: ',', 0xf5: '♀',
};

// A-Z, a-z and 0-9 are contiguous runs, so fill them in programmatically.
for (let i = 0; i < 26; i++) {
  TABLE[0x80 + i] = String.fromCharCode(65 + i); // A-Z
  TABLE[0xa0 + i] = String.fromCharCode(97 + i); // a-z
}
for (let i = 0; i < 10; i++) {
  TABLE[0xf6 + i] = String.fromCharCode(48 + i); // 0-9
}

export const MENU_CURSOR_TILE = 0xed;
export const TEXT_PROMPT_TILE = 0xee;
export const SPACE_TILE = 0x7f;
export const STRING_TERMINATOR = 0x50;

/** Decode a single tile/character byte. Unknown bytes become a space. */
export function decodeChar(byte: number): string {
  const ch = TABLE[byte];
  return ch === undefined ? ' ' : ch;
}

/**
 * Decode a RAM string (terminated by 0x50 or by running out of bytes).
 * Used for Pokemon nicknames, the player's name, trainer names.
 */
export function decodeString(bytes: ArrayLike<number>, offset = 0, maxLength = 11): string {
  let out = '';
  for (let i = 0; i < maxLength; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined || byte === STRING_TERMINATOR || byte === 0x00) break;
    out += decodeChar(byte);
  }
  return out.trim();
}
