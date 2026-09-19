import type { GameBoy } from '../../src/emulator/gameboy.ts';
import { ADDR } from '../../src/game/addresses.ts';

/**
 * A stand-in for the emulator backed by a plain memory array.
 *
 * Lets us plant an exact battle situation in RAM and assert what the state
 * reader and battle analysis make of it, with no ROM and no emulation.
 */
export class FakeGameBoy {
  readonly mem = new Uint8Array(0x10000);
  frameCount = 0;

  readByte(address: number): number {
    return this.mem[address] ?? 0;
  }

  readWord(address: number): number {
    return ((this.mem[address] ?? 0) << 8) | (this.mem[address + 1] ?? 0);
  }

  readRange(start: number, length: number): number[] {
    return Array.from(this.mem.slice(start, start + length));
  }

  memory(): number[] {
    return Array.from(this.mem);
  }

  writeByte(address: number, value: number): void {
    this.mem[address] = value & 0xff;
  }

  writeWord(address: number, value: number): void {
    this.mem[address] = (value >> 8) & 0xff;
    this.mem[address + 1] = value & 0xff;
  }

  writeBytes(address: number, values: number[]): void {
    values.forEach((value, i) => {
      this.mem[address + i] = value & 0xff;
    });
  }

  /** Write text into the tile map using Pokemon's character encoding. */
  writeScreenText(row: number, col: number, text: string): void {
    const base = ADDR.TILE_MAP + row * ADDR.TILE_MAP_WIDTH + col;
    [...text].forEach((char, i) => {
      this.mem[base + i] = encodeChar(char);
    });
  }

  fillScreen(tile = 0x7f): void {
    this.mem.fill(tile, ADDR.TILE_MAP, ADDR.TILE_MAP + ADDR.TILE_MAP_WIDTH * ADDR.TILE_MAP_HEIGHT);
  }

  /** Structural cast: the state reader only uses the read methods above. */
  asGameBoy(): GameBoy {
    return this as unknown as GameBoy;
  }
}

export function encodeChar(char: string): number {
  if (char === ' ') return 0x7f;
  if (char === '▶') return 0xed;
  if (char === '▼') return 0xee;
  if (char >= 'A' && char <= 'Z') return 0x80 + (char.charCodeAt(0) - 65);
  if (char >= 'a' && char <= 'z') return 0xa0 + (char.charCodeAt(0) - 97);
  if (char >= '0' && char <= '9') return 0xf6 + (char.charCodeAt(0) - 48);
  if (char === '/') return 0xf3;
  if (char === '.') return 0xe8;
  if (char === '?') return 0xe6;
  if (char === '!') return 0xe7;
  if (char === '-') return 0xe3;
  return 0x7f;
}

export function encodeString(text: string, length = text.length + 1): number[] {
  const bytes = [...text].map(encodeChar);
  bytes.push(0x50); // terminator
  while (bytes.length < length) bytes.push(0x50);
  return bytes;
}
