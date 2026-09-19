declare module 'serverboy' {
  interface GameboyInstance {
    loadRom(rom: Buffer | number[] | Uint8Array, saveData?: number[]): boolean;
    doFrame(partial?: boolean): number[];
    pressKey(key: number | string): void;
    pressKeys(keys: (number | string)[]): void;
    getKeys(): boolean[];
    getScreen(): number[];
    getMemory(start?: number, end?: number): number[];
    getAudio(): number[];
    getSaveData(): number[];
  }
  interface GameboyConstructor {
    new (): GameboyInstance;
    KEYMAP: Record<string, number>;
  }
  const Gameboy: GameboyConstructor;
  export default Gameboy;
}

declare module 'serverboy/src/gameboy_core/saveState.js' {
  const saveStateModule: {
    saveState: (this: unknown) => unknown[];
    returnFromState: (this: unknown, state: unknown[]) => void;
  };
  export default saveStateModule;
}
