/**
 * Cartridge header validation.
 *
 * Shared by the upload script and the upload route so both agree on what
 * counts as a usable ROM. Jev's memory map is written for Pokemon Red (US/EU);
 * pointing it at another game would not error, it would just silently misread
 * every address, so it is worth being strict here.
 */
export interface RomInfo {
  valid: boolean;
  title: string;
  size: number;
  /** True when the cartridge header is a Game Boy one at all. */
  isGameBoy: boolean;
  /** True when the title says POKEMON RED. */
  isPokemonRed: boolean;
  headerChecksumOk: boolean;
  problems: string[];
  warnings: string[];
}

const LOGO_START = [0xce, 0xed, 0x66, 0x66];

export function inspectRom(rom: Uint8Array): RomInfo {
  const problems: string[] = [];
  const warnings: string[] = [];

  const isGameBoy =
    rom.length >= 0x150 && LOGO_START.every((byte, i) => rom[0x104 + i] === byte);
  if (!isGameBoy) problems.push('not a Game Boy ROM (the cartridge header is missing)');

  const title = isGameBoy
    ? Buffer.from(rom.subarray(0x134, 0x143)).toString('ascii').replace(/\0+$/, '').trim()
    : '';

  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - (rom[i] ?? 0) - 1) & 0xff;
  const headerChecksumOk = isGameBoy && checksum === rom[0x14d];
  if (isGameBoy && !headerChecksumOk) {
    warnings.push('header checksum does not match — the dump may be corrupt');
  }

  const isPokemonRed = /POKEMON RED/i.test(title);
  if (isGameBoy && !isPokemonRed) {
    problems.push(
      `cartridge title is "${title}", expected "POKEMON RED" — Jev's memory map is ` +
        'written for Pokemon Red and would misread another game',
    );
  }

  if (isGameBoy && rom.length !== 1024 * 1024) {
    warnings.push(`unusual size ${rom.length} bytes; Pokemon Red is exactly 1MB`);
  }

  return {
    valid: problems.length === 0,
    title,
    size: rom.length,
    isGameBoy,
    isPokemonRed,
    headerChecksumOk,
    problems,
    warnings,
  };
}
