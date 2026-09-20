import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGameBoy, encodeString } from './helpers/fake-gameboy.ts';
import { ADDR } from '../src/game/addresses.ts';
import { readGameState } from '../src/game/state.ts';
import { detectIntroPhase, introInputs } from '../src/game/intro.ts';
import { fingerprint, trackStuck, shakeButton, stuckWarning, SHAKE_AFTER, NUDGE_AFTER, INTRO_PATIENCE } from '../src/harness/stuck.ts';
import { emptyJournal, type Journal } from '../src/jev/journal.ts';
import { takeTurn } from '../src/harness/turn.ts';
import { loadConfig } from '../src/jev/model.ts';

/**
 * Screens from the opening.
 *
 * These are the tile maps the real game draws; the point of the tests is that
 * each one has exactly one right answer and the harness knows it without
 * asking a model, because the whole bug was a model being asked and failing.
 */
function screen(lines: [row: number, col: number, text: string][], playerName = '') {
  const gb = new FakeGameBoy();
  gb.fillScreen();
  for (const [row, col, text] of lines) gb.writeScreenText(row, col, text);
  if (playerName) gb.writeBytes(ADDR.wPlayerName, encodeString(playerName, ADDR.NICK_SIZE));
  return readGameState(gb.asGameBoy());
}

describe('getting into the game without asking anyone', () => {
  test('an empty title screen is not mistaken for standing in Pallet Town', () => {
    // This is the exact failure: map 0 is PALLET TOWN and x/y are 0, so the
    // state reader alone says "you are in the game, go to Oak's house".
    const state = screen([]);
    assert.equal(state.world.mapName, 'PALLET TOWN', 'the misleading reading is still there');
    assert.equal(detectIntroPhase(state), 'title', 'but the harness is not fooled');
    assert.deepEqual(introInputs('title'), ['START']);
  });

  test('the attract demo is still the title screen', () => {
    // Left alone, the title falls into a demo battle. Nothing about it means
    // the game has started, and START backs out of it.
    const state = screen([[7, 2, 'GENGAR'], [12, 2, 'NIDORINO']]);
    assert.equal(detectIntroPhase(state), 'title');
  });

  test('NEW GAME is confirmed, not deliberated over', () => {
    const state = screen([[2, 3, '▶NEW GAME'], [4, 3, 'OPTION']]);
    assert.equal(detectIntroPhase(state), 'main-menu');
    assert.deepEqual(introInputs('main-menu'), ['A']);
  });

  test('the name picker takes a preset instead of typing on the grid', () => {
    const state = screen([[2, 1, '▶NEW NAME'], [4, 1, 'RED'], [6, 1, 'ASH'], [8, 1, 'JACK']]);
    assert.equal(detectIntroPhase(state), 'naming');
    // DOWN moves off NEW NAME onto RED; A takes it. One press each, no grid.
    assert.deepEqual(introInputs('naming'), ['DOWN', 'A']);
  });

  test("Oak's speech is advanced with A, not START", () => {
    // The trap: the player has no name yet, so a name-only rule would call
    // this the title screen and press START at a text box forever.
    const state = screen([[14, 1, 'HELLO THERE! ▼']]);
    assert.equal(detectIntroPhase(state), 'text');
    assert.deepEqual(introInputs('text'), ['A']);
  });

  test('the rival name picker is handled the same way', () => {
    const state = screen([[2, 1, '▶NEW NAME'], [4, 1, 'BLUE']], 'RED');
    assert.equal(detectIntroPhase(state), 'naming');
  });

  test('once named and out of the menus, the intro is over', () => {
    const state = screen([], 'RED');
    assert.equal(detectIntroPhase(state), null, 'Jev takes it from here');
  });

  test('a text box during normal play is not the intro', () => {
    const state = screen([[14, 1, 'YOU FOUND A POTION! ▼']], 'RED');
    assert.equal(detectIntroPhase(state), null, 'the ordinary text path handles it');
  });
});

describe('noticing that nothing is happening', () => {
  const still = () => screen([[2, 3, '▶NEW GAME']]);

  test('an identical screen counts as a turn wasted', () => {
    let stuck = trackStuck(undefined, still());
    assert.equal(stuck.turns, 0, 'the first sighting is not yet a repeat');
    stuck = trackStuck(stuck, still());
    stuck = trackStuck(stuck, still());
    assert.equal(stuck.turns, 2);
  });

  test('any observable change resets the count', () => {
    let stuck = trackStuck(undefined, still());
    for (let i = 0; i < 20; i++) stuck = trackStuck(stuck, still());
    assert.equal(stuck.turns, 20);
    stuck = trackStuck(stuck, screen([[2, 3, '▶OPTION']]));
    assert.equal(stuck.turns, 0);
  });

  test('walking with the same screen still counts as progress', () => {
    // Screen text alone would call an open field "unchanged"; position saves it.
    const gb = new FakeGameBoy();
    gb.fillScreen();
    gb.writeByte(ADDR.wXCoord, 5);
    const before = readGameState(gb.asGameBoy());
    gb.writeByte(ADDR.wXCoord, 6);
    const after = readGameState(gb.asGameBoy());
    assert.notEqual(fingerprint(before), fingerprint(after));
  });

  test('the model is told before the harness overrides it', () => {
    assert.equal(stuckWarning(NUDGE_AFTER - 1), null, 'a couple of quiet turns is normal');
    assert.match(stuckWarning(NUDGE_AFTER)!, /not working/);
    assert.ok(NUDGE_AFTER < SHAKE_AFTER, 'ask nicely first, then take over');
  });

  test('the shake cycles buttons instead of retrying one forever', () => {
    const tried = new Set<string>();
    for (let i = 0; i < 8; i++) tried.add(shakeButton(SHAKE_AFTER + i));
    assert.ok(tried.size >= 6, `should try several different buttons, tried ${[...tried]}`);
    assert.equal(shakeButton(SHAKE_AFTER), 'START', 'a menu opened by accident eats every other input');
    assert.ok(tried.has('B'), 'B backs out of a menu');
  });
});

describe('the play loop refuses to burn turns on the title screen', () => {
  /** Records presses; the intro and shake paths only ever press buttons. */
  function recordingController() {
    const pressed: string[] = [];
    return {
      pressed,
      controller: {
        press: (button: string, times = 1) => {
          for (let i = 0; i < times; i++) pressed.push(button);
        },
        advanceText: () => 0,
        waitFor: () => true,
      },
    };
  }

  async function turnOn(state: ReturnType<typeof screen>, journal: Journal) {
    const { pressed, controller } = recordingController();
    const outcome = await takeTurn({
      gb: {} as never,
      controller: controller as never,
      // A real model would be a network call; nothing below should reach one.
      config: loadConfig({ mode: 'evaluate', offline: false }),
      journal,
      state,
      analysis: null,
    });
    return { outcome, pressed };
  }

  test('the title screen presses START without paying for a decision', async () => {
    const { outcome, pressed } = await turnOn(screen([]), emptyJournal());

    assert.equal(outcome.kind, 'intro');
    assert.deepEqual(pressed, ['START']);
    assert.equal(outcome.model, '(none)', 'the intro costs nothing');
    assert.match(outcome.reasoning, /Not in the game yet/);
  });

  test('a wedged game is shaken loose instead of asked again', async () => {
    const journal = emptyJournal();
    // A named player standing in a screen that never changes: past the intro,
    // so without the shake this is the overworld agent answering forever.
    const frozen = screen([[3, 3, 'NOTHING EVER CHANGES']], 'RED');

    const kinds: string[] = [];
    const buttons: string[] = [];
    for (let i = 0; i < SHAKE_AFTER + 4; i++) {
      const { outcome, pressed } = await turnOn(frozen, journal);
      kinds.push(outcome.kind);
      buttons.push(...pressed);
      if (outcome.kind === 'stuck') break;
    }

    assert.equal(kinds.at(-1), 'stuck', `gave up asking after ${kinds.length} identical turns`);
    assert.ok(kinds.length <= SHAKE_AFTER + 1, 'and did not wait 6000 turns to do it');
    assert.equal(buttons.at(-1), 'START');
    assert.equal(journal.stuck?.turns, SHAKE_AFTER);
  });
});

describe('an intro that never ends', () => {
  test('gives up rather than pressing START at the title screen forever', async () => {
    // The failure the ordinary stuck check cannot see: START opens and closes
    // the menu, so the screen keeps changing while nothing progresses.
    const journal = emptyJournal();
    journal.stuck = { fingerprint: '', turns: 0, intro: INTRO_PATIENCE + 1 };

    const pressed: string[] = [];
    const outcome = await takeTurn({
      gb: {} as never,
      controller: {
        press: (button: string) => pressed.push(button),
        advanceText: () => 0,
        waitFor: () => true,
      } as never,
      config: loadConfig({ mode: 'evaluate', offline: false }),
      journal,
      state: screen([]),
      analysis: null,
    });

    assert.equal(outcome.kind, 'stuck', 'not "intro" for the two-hundredth time');
    assert.match(outcome.reasoning, /opening has run/);
    assert.equal(pressed.length, 1);
  });

  test('a normal opening is nowhere near the limit', () => {
    // Oak's speech is a dozen text boxes and each costs a turn, so the limit
    // has to be generous enough not to cut a real intro short.
    assert.ok(INTRO_PATIENCE > 100);
  });
});
