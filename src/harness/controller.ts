import { GameBoy, type Button } from '../emulator/gameboy.ts';
import { readScreenText, isBattleMenu, isMoveMenu, type ScreenText } from '../game/screen.ts';
import { ADDR } from '../game/addresses.ts';

export interface ControllerOptions {
  /** Frames to hold each button. */
  hold?: number;
  /** Frames to idle after releasing, letting the game animate. */
  release?: number;
}

/**
 * Turns intentions ("use move 2", "switch to slot 1") into button presses.
 *
 * Every navigation step is closed-loop: we press, re-read the screen, and check
 * whether the cursor actually moved where we wanted. Open-loop button sequences
 * drift out of sync the moment an animation takes a frame longer than expected,
 * and in a 10-hour run that drift is fatal.
 */
export class Controller {
  #gb: GameBoy;
  #hold: number;
  #release: number;

  constructor(gb: GameBoy, options: ControllerOptions = {}) {
    this.#gb = gb;
    this.#hold = options.hold ?? 8;
    this.#release = options.release ?? 10;
  }

  press(button: Button, times = 1): void {
    for (let i = 0; i < times; i++) {
      this.#gb.press(button, { hold: this.#hold, release: this.#release });
    }
  }

  screen(): ScreenText {
    return readScreenText(this.#gb);
  }

  /**
   * The text to the right of the ▶ cursor.
   *
   * This is the rest of the row, not a single word, because Red's battle menu
   * puts two entries on one line ("FIGHT PKMN") and move names contain spaces
   * ("ICE BEAM"). Callers therefore match with `startsWith`, which stays
   * correct in both cases.
   */
  cursorLabel(screen = this.screen()): string | null {
    if (screen.cursorRow < 0) return null;
    const row = screen.rows[screen.cursorRow] ?? '';
    const label = row.slice(screen.cursorCol + 1).trim();
    return label.length > 0 ? label : null;
  }

  /** Run frames until `predicate` holds or we run out of patience. */
  waitFor(predicate: (screen: ScreenText) => boolean, maxFrames = 600): boolean {
    for (let i = 0; i < maxFrames; i += 4) {
      if (predicate(this.screen())) return true;
      this.#gb.advance(4);
    }
    return predicate(this.screen());
  }

  /** Press A through text boxes until something else needs a decision. */
  advanceText(maxPresses = 12): number {
    let presses = 0;
    while (presses < maxPresses) {
      const screen = this.screen();
      if (!screen.awaitingInput) {
        // Give the game a moment in case the next box is still drawing.
        this.#gb.advance(12);
        if (!this.screen().awaitingInput) break;
      }
      this.press('A');
      presses++;
    }
    return presses;
  }

  /**
   * Sweep a one-dimensional menu (moves, party, bag) in one direction until the
   * cursor lands on a matching entry. Stops as soon as it sees a label twice,
   * which means the list has wrapped and the entry is not there.
   */
  navigateList(
    matches: (label: string) => boolean,
    direction: Button = 'DOWN',
    maxSteps = 10,
  ): boolean {
    const seen = new Set<string>();
    for (let step = 0; step < maxSteps; step++) {
      const label = this.cursorLabel();
      if (label && matches(label)) return true;
      if (label) {
        if (seen.has(label)) return false;
        seen.add(label);
      }
      this.press(direction);
    }
    return this.#labelMatches(matches);
  }

  /**
   * Navigate Red's 2x2 battle menu (FIGHT / PKMN over ITEM / RUN).
   *
   * A single direction can never reach the diagonal entry, so this alternates
   * between the two axes; DOWN, RIGHT, DOWN, RIGHT visits all four cells from
   * wherever the cursor happens to be.
   */
  navigateGrid(
    matches: (label: string) => boolean,
    directions: Button[] = ['DOWN', 'RIGHT'],
    maxSteps = 5,
  ): boolean {
    for (let step = 0; step < maxSteps; step++) {
      if (this.#labelMatches(matches)) return true;
      this.press(directions[step % directions.length]!);
    }
    return this.#labelMatches(matches);
  }

  #labelMatches(matches: (label: string) => boolean): boolean {
    const label = this.cursorLabel();
    return label !== null && matches(label);
  }

  /** Index of the highlighted entry, straight from RAM. */
  menuIndex(): number {
    return this.#gb.readByte(ADDR.wCurrentMenuItem);
  }

  // --- battle actions ----------------------------------------------------

  /** Select FIGHT and open the move list. */
  openMoveList(): boolean {
    if (isMoveMenu(this.screen()) && !isBattleMenu(this.screen())) return true;
    if (!this.waitFor(isBattleMenu, 400)) return false;

    this.navigateGrid((label) => label.toUpperCase().startsWith('FIGHT'));
    this.press('A');
    return this.waitFor((screen) => isMoveMenu(screen) && !isBattleMenu(screen), 240);
  }

  /** Use the move in the given slot, identified by name so we cannot mis-click. */
  useMove(moveName: string): boolean {
    if (!this.openMoveList()) return false;
    const target = moveName.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const found = this.navigateList(
      (label) => label.toUpperCase().replace(/[^A-Z0-9]/g, '').startsWith(target.slice(0, 6)),
      'DOWN',
      5,
    );
    if (!found) {
      // Cursor is somewhere in the move list; commit anyway rather than hang.
      this.press('A');
      return false;
    }
    this.press('A');
    return true;
  }

  /** Open the battle menu's PKMN list and switch to a party member by name. */
  switchTo(name: string): boolean {
    if (!this.waitFor(isBattleMenu, 400)) return false;
    this.navigateGrid((label) => label.toUpperCase().startsWith('PKMN'));
    this.press('A');
    this.#gb.advance(30);

    const target = name.toUpperCase().slice(0, 5);
    const found = this.navigateList((label) => label.toUpperCase().startsWith(target), 'DOWN', 7);
    if (!found) {
      this.press('B');
      return false;
    }
    this.press('A');
    this.#gb.advance(20);
    // The party screen offers SWITCH / STATS / CANCEL; SWITCH is the first entry.
    this.navigateList((label) => label.toUpperCase().startsWith('SWITCH'), 'UP', 4);
    this.press('A');
    return true;
  }

  /** Use a bag item from inside a battle. */
  useItem(itemName: string): boolean {
    if (!this.waitFor(isBattleMenu, 400)) return false;
    this.navigateGrid((label) => label.toUpperCase().startsWith('ITEM'));
    this.press('A');
    this.#gb.advance(30);

    const target = itemName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const found = this.navigateList(
      (label) => label.toUpperCase().replace(/[^A-Z0-9]/g, '').startsWith(target),
      'DOWN',
      14,
    );
    if (!found) {
      this.press('B');
      this.press('B');
      return false;
    }
    this.press('A');
    return true;
  }

  /** Attempt to flee a wild battle. */
  run(): boolean {
    if (!this.waitFor(isBattleMenu, 400)) return false;
    this.navigateGrid((label) => label.toUpperCase().startsWith('RUN'));
    this.press('A');
    return true;
  }
}
