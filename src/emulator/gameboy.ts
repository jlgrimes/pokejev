import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const Gameboy = require('serverboy') as any;
const saveStateModule = require('serverboy/src/gameboy_core/saveState.js') as {
  saveState: () => unknown[];
  returnFromState: (state: unknown[]) => void;
};

export const BUTTONS = ['RIGHT', 'LEFT', 'UP', 'DOWN', 'A', 'B', 'SELECT', 'START'] as const;
export type Button = (typeof BUTTONS)[number];

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;

export interface PressOptions {
  /** Frames to hold the button down. */
  hold?: number;
  /** Frames to wait with nothing pressed afterwards. */
  release?: number;
}

/** Opaque emulator snapshot; JSON-serialisable so it can be written to disk. */
export type SaveState = { frames: number; state: unknown[] };

/**
 * Typed, frame-stepped wrapper around serverboy.
 *
 * Nothing advances unless we call it, which is what makes an LLM player
 * practical: we can take as long as we like thinking between frames, and the
 * game state is frozen while we do.
 */
export class GameBoy {
  #gb: any;
  #core: any;
  #frames = 0;

  /** Called after every emulated frame. Used to stream video to the viewer. */
  onFrame: ((gb: GameBoy) => void) | null = null;

  constructor() {
    this.#gb = new Gameboy();
  }

  /** Load a ROM buffer, optionally restoring battery-backed save data. */
  loadRom(rom: Buffer | Uint8Array, saveData?: number[]): void {
    this.#gb.loadRom(rom, saveData);
    // serverboy hides the emulator core behind a run-time-generated key. We need
    // it for save states, which the public interface does not expose.
    const privateKey = Object.keys(this.#gb)[0];
    this.#core = privateKey ? this.#gb[privateKey]?.gameboy : undefined;
    this.#frames = 0;
  }

  static fromFile(romPath: string, savePath?: string): GameBoy {
    if (!existsSync(romPath)) {
      throw new Error(
        `ROM not found at ${romPath}. Supply your own legally obtained Pokemon Red ROM ` +
          `and point ROM_PATH at it (see README).`,
      );
    }
    const gb = new GameBoy();
    const save =
      savePath && existsSync(savePath)
        ? (JSON.parse(readFileSync(savePath, 'utf8')) as number[])
        : undefined;
    gb.loadRom(readFileSync(romPath), save);
    return gb;
  }

  get frameCount(): number {
    return this.#frames;
  }

  /** Advance exactly one video frame. */
  step(): void {
    this.#gb.doFrame();
    this.#frames++;
    this.onFrame?.(this);
  }

  /** Advance `count` frames with no input. */
  advance(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  /**
   * Press one or more buttons.
   *
   * serverboy releases keys at the end of every frame, so holding means
   * re-pressing each frame. Defaults are tuned for Pokemon Red's input polling:
   * anything shorter than ~4 frames is unreliable.
   */
  press(buttons: Button | Button[], options: PressOptions = {}): void {
    const list = Array.isArray(buttons) ? buttons : [buttons];
    const hold = options.hold ?? 8;
    const release = options.release ?? 8;
    for (let i = 0; i < hold; i++) {
      this.#gb.pressKeys(list as unknown as string[]);
      this.step();
    }
    this.advance(release);
  }

  /** Read a single byte of the Game Boy address space. */
  readByte(address: number): number {
    return this.#gb.getMemory()[address] ?? 0;
  }

  /** Read a big-endian 16-bit value (the layout Pokemon uses for HP and stats). */
  readWord(address: number): number {
    const memory = this.#gb.getMemory();
    return ((memory[address] ?? 0) << 8) | (memory[address + 1] ?? 0);
  }

  readRange(start: number, length: number): number[] {
    const memory = this.#gb.getMemory();
    const out: number[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = memory[start + i] ?? 0;
    return out;
  }

  /** The whole address space. Cheap — serverboy hands back its live array. */
  memory(): number[] {
    return this.#gb.getMemory();
  }

  /** Current frame as RGBA bytes, 160x144. */
  screen(): number[] {
    return this.#gb.getScreen();
  }

  /** Battery-backed SRAM, i.e. what an in-game SAVE writes to. */
  sram(): number[] {
    return this.#gb.getSaveData();
  }

  writeSram(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.sram()));
  }

  /**
   * Full emulator snapshot (CPU, RAM, VRAM, timers) — not the in-game save.
   * Useful for rewinding a bad decision or for replaying a battle.
   */
  saveState(): SaveState {
    if (!this.#core) throw new Error('No ROM loaded; cannot save state.');
    return { frames: this.#frames, state: saveStateModule.saveState.call(this.#core) };
  }

  loadState(snapshot: SaveState): void {
    if (!this.#core) throw new Error('No ROM loaded; cannot restore state.');
    saveStateModule.returnFromState.call(this.#core, snapshot.state);
    this.#frames = snapshot.frames;
  }

  writeStateFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.saveState()));
  }

  readStateFile(path: string): void {
    this.loadState(JSON.parse(readFileSync(path, 'utf8')) as SaveState);
  }
}
