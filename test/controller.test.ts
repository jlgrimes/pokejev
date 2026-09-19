import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGameBoy } from './helpers/fake-gameboy.ts';
import { Controller } from '../src/harness/controller.ts';
import { ADDR } from '../src/game/addresses.ts';
import type { GameBoy, Button } from '../src/emulator/gameboy.ts';

/**
 * A fake that behaves like Red's 2x2 battle menu: the cursor moves between
 * FIGHT / PKMN / ITEM / RUN and is redrawn into the tile map each press, so the
 * controller's closed-loop navigation has something real to read back.
 */
class MenuGameBoy extends FakeGameBoy {
  index = 0;
  presses: Button[] = [];
  #items = [
    { label: 'FIGHT', row: 14, col: 9 },
    { label: 'PKMN', row: 14, col: 15 },
    { label: 'ITEM', row: 16, col: 9 },
    { label: 'RUN', row: 16, col: 15 },
  ];

  constructor() {
    super();
    this.#draw();
  }

  #draw(): void {
    this.fillScreen();
    this.#items.forEach((item, i) => {
      this.writeScreenText(item.row, item.col, `${i === this.index ? '▶' : ' '}${item.label}`);
    });
    this.writeByte(ADDR.wCurrentMenuItem, this.index);
    this.writeByte(ADDR.wMaxMenuItem, 3);
  }

  press(button: Button | Button[]): void {
    const pressed = Array.isArray(button) ? button[0]! : button;
    this.presses.push(pressed);
    if (pressed === 'DOWN' || pressed === 'UP') this.index = (this.index + 2) % 4;
    if (pressed === 'LEFT' || pressed === 'RIGHT') this.index ^= 1;
    this.#draw();
  }

  advance(): void {
    /* nothing to emulate */
  }
}

describe('menu navigation', () => {
  test('reads the label next to the cursor', () => {
    const gb = new MenuGameBoy();
    const controller = new Controller(gb as unknown as GameBoy);
    // The battle menu puts FIGHT and PKMN on the same row, so the label is the
    // rest of the line and callers match on its start.
    assert.ok(controller.cursorLabel()!.startsWith('FIGHT'));

    gb.press('RIGHT');
    assert.equal(controller.cursorLabel(), 'PKMN');
  });

  test('reaches the diagonal entry in the 2x2 battle menu', () => {
    const gb = new MenuGameBoy();
    const controller = new Controller(gb as unknown as GameBoy);

    const found = controller.navigateGrid((label) => label.startsWith('RUN'));
    assert.equal(found, true);
    assert.equal(controller.cursorLabel(), 'RUN');
    assert.equal(gb.index, 3);
  });

  test('does not press anything when already on target', () => {
    const gb = new MenuGameBoy();
    const controller = new Controller(gb as unknown as GameBoy);

    controller.navigateGrid((label) => label.startsWith('FIGHT'));
    assert.deepEqual(gb.presses, []);
  });

  test('gives up rather than looping forever on a missing entry', () => {
    const gb = new MenuGameBoy();
    const controller = new Controller(gb as unknown as GameBoy);

    const found = controller.navigateList((label) => label.startsWith('SURRENDER'), 'DOWN');
    assert.equal(found, false);
    // It stopped once it had seen every label rather than pressing forever.
    assert.ok(gb.presses.length <= 4, `pressed ${gb.presses.length} times`);
  });

  test('reports the highlighted index from RAM', () => {
    const gb = new MenuGameBoy();
    const controller = new Controller(gb as unknown as GameBoy);
    gb.press('DOWN');
    assert.equal(controller.menuIndex(), 2);
  });
});
