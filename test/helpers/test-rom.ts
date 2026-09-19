/**
 * A hand-assembled 32KB Game Boy ROM used to test the harness end to end
 * without needing a copyrighted commercial ROM.
 *
 * The program writes "HELLO" into the tile map at 0xC3A0 (using Pokemon's own
 * character codes, so the screen-text decoder can be tested against it), then
 * loops forever polling the joypad and mirroring what it reads into WRAM:
 *
 *   0xC000 - d-pad bits   (bit0 Right, bit1 Left, bit2 Up, bit3 Down)
 *   0xC001 - button bits  (bit0 A, bit1 B, bit2 Select, bit3 Start)
 *   0xC002 - a counter incremented once per loop iteration
 */
export const TEST_ADDR = {
  DPAD: 0xc000,
  BUTTONS: 0xc001,
  COUNTER: 0xc002,
  TILEMAP: 0xc3a0,
} as const;

const PROGRAM: number[] = [
  0x21, 0xa0, 0xc3, //       ld hl, $C3A0
  0x3e, 0x87, //             ld a, $87   ; 'H'
  0x22, //                   ld (hl+), a
  0x3e, 0x84, //             ld a, $84   ; 'E'
  0x22, //                   ld (hl+), a
  0x3e, 0x8b, //             ld a, $8B   ; 'L'
  0x22, //                   ld (hl+), a
  0x22, //                   ld (hl+), a ; 'L'
  0x3e, 0x8e, //             ld a, $8E   ; 'O'
  0x22, //                   ld (hl+), a
  // loop:
  0x3e, 0x20, //             ld a, $20   ; select the d-pad row
  0xe0, 0x00, //             ldh ($00), a
  0xf0, 0x00, //             ldh a, ($00)
  0xf0, 0x00, //             ldh a, ($00) ; read twice to let the lines settle
  0x2f, //                   cpl          ; invert so 1 = pressed
  0xe6, 0x0f, //             and $0F
  0xea, 0x00, 0xc0, //       ld ($C000), a
  0x3e, 0x10, //             ld a, $10   ; select the button row
  0xe0, 0x00, //             ldh ($00), a
  0xf0, 0x00, //             ldh a, ($00)
  0xf0, 0x00, //             ldh a, ($00)
  0x2f, //                   cpl
  0xe6, 0x0f, //             and $0F
  0xea, 0x01, 0xc0, //       ld ($C001), a
  0xfa, 0x02, 0xc0, //       ld a, ($C002)
  0x3c, //                   inc a
  0xea, 0x02, 0xc0, //       ld ($C002), a
  0x18, 0xdb, //             jr loop
];

/** The logo the hardware boot ROM scrolls; some emulators validate it. */
const NINTENDO_LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];

export function buildTestRom(): Buffer {
  const rom = Buffer.alloc(0x8000, 0x00);

  // Entry point: skip the header, jump to the program.
  rom[0x100] = 0x00; // nop
  rom[0x101] = 0xc3; // jp $0150
  rom[0x102] = 0x50;
  rom[0x103] = 0x01;

  NINTENDO_LOGO.forEach((byte, i) => {
    rom[0x104 + i] = byte;
  });

  Buffer.from('JEVTEST').copy(rom, 0x134); // title
  rom[0x147] = 0x00; // cartridge type: ROM only
  rom[0x148] = 0x00; // ROM size: 32KB
  rom[0x149] = 0x00; // RAM size: none

  // Header checksum over 0x134..0x14C.
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - (rom[i] ?? 0) - 1) & 0xff;
  rom[0x14d] = checksum;

  PROGRAM.forEach((byte, i) => {
    rom[0x150 + i] = byte;
  });

  return rom;
}
