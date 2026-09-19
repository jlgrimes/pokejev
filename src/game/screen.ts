import { ADDR } from './addresses.ts';
import { decodeChar, MENU_CURSOR_TILE, TEXT_PROMPT_TILE } from './charmap.ts';
import type { GameBoy } from '../emulator/gameboy.ts';

export interface ScreenText {
  /** 18 rows of 20 characters, exactly as laid out on the Game Boy screen. */
  rows: string[];
  /** All rows joined, for substring checks. */
  flat: string;
  /** Row index the menu cursor (▶) sits on, or -1. */
  cursorRow: number;
  /** Column index of the menu cursor, or -1. */
  cursorCol: number;
  /** True when the game is waiting for A/B to continue a text box (▼). */
  awaitingInput: boolean;
}

/**
 * Decode the tile map into readable text.
 *
 * Because Red's font tiles live at the same indices as its text encoding, the
 * tile map *is* the text on screen. This is exact where OCR would be a guess,
 * and it costs a memory read rather than a vision call.
 */
export function readScreenText(gb: GameBoy): ScreenText {
  const tiles = gb.readRange(ADDR.TILE_MAP, ADDR.TILE_MAP_WIDTH * ADDR.TILE_MAP_HEIGHT);
  const rows: string[] = [];
  let cursorRow = -1;
  let cursorCol = -1;
  let awaitingInput = false;

  for (let y = 0; y < ADDR.TILE_MAP_HEIGHT; y++) {
    let row = '';
    for (let x = 0; x < ADDR.TILE_MAP_WIDTH; x++) {
      const tile = tiles[y * ADDR.TILE_MAP_WIDTH + x] ?? 0;
      if (tile === MENU_CURSOR_TILE && cursorRow === -1) {
        cursorRow = y;
        cursorCol = x;
      }
      if (tile === TEXT_PROMPT_TILE) awaitingInput = true;
      row += decodeChar(tile);
    }
    rows.push(row.replace(/\s+$/, ''));
  }

  return { rows, flat: rows.join('\n'), cursorRow, cursorCol, awaitingInput };
}

/** Case-insensitive search across the whole screen. */
export function screenHas(screen: ScreenText, needle: string): boolean {
  return screen.flat.toUpperCase().includes(needle.toUpperCase());
}

/** The battle's top-level FIGHT / PKMN / ITEM / RUN menu. */
export function isBattleMenu(screen: ScreenText): boolean {
  return screenHas(screen, 'FIGHT') && screenHas(screen, 'RUN');
}

/** The move-selection list, identified by the TYPE/ header of its info box. */
export function isMoveMenu(screen: ScreenText): boolean {
  return screenHas(screen, 'TYPE/') || (screenHas(screen, 'PP') && !isBattleMenu(screen));
}

/** Trim the screen down to the lines that actually have text on them. */
export function nonEmptyLines(screen: ScreenText): string[] {
  return screen.rows.filter((row) => row.trim().length > 0);
}
