import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGameBoy, encodeString } from './helpers/fake-gameboy.ts';
import { ADDR } from '../src/game/addresses.ts';
import { readGameState } from '../src/game/state.ts';
import {
  emptyWorld, mark, markExit, routeTo, frontiers, bearing, terrainAt, exitsOf, explored,
} from '../src/game/world-map.ts';
import { walkStep, followRoute } from '../src/harness/navigator.ts';
import { optionsFor, fallbackDestination } from '../src/jev/destination.ts';
import { emptyJournal } from '../src/jev/journal.ts';

const PALLET = 0;

/**
 * A walkable world behind the emulator interface.
 *
 * `walls` are the tiles the player cannot enter. Pressing a direction moves
 * the player exactly as the real game would, including the Gen 1 rule that
 * the first press towards a new direction only turns you.
 */
class FakeOverworld extends FakeGameBoy {
  facing: string | null = null;
  readonly visited: string[] = [];

  constructor(
    private walls: Set<string>,
    x = 5,
    y = 5,
    private doors = new Map<string, number>(),
  ) {
    super();
    this.fillScreen();
    this.writeBytes(ADDR.wPlayerName, encodeString('RED', ADDR.NICK_SIZE));
    this.writeByte(ADDR.wXCoord, x);
    this.writeByte(ADDR.wYCoord, y);
    this.visited.push(`${x},${y}`);
  }

  press(button: string): void {
    const deltas: Record<string, [number, number]> = {
      UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0],
    };
    const delta = deltas[button];
    if (!delta) return;
    // Gen 1: the first press in a new direction turns you, it does not walk.
    if (this.facing !== button) { this.facing = button; return; }
    const x = this.readByte(ADDR.wXCoord) + delta[0];
    const y = this.readByte(ADDR.wYCoord) + delta[1];
    if (this.walls.has(`${x},${y}`)) return;
    const door = this.doors.get(`${x},${y}`);
    if (door !== undefined) { this.writeByte(ADDR.wCurMap, door); return; }
    this.writeByte(ADDR.wXCoord, x);
    this.writeByte(ADDR.wYCoord, y);
    this.visited.push(`${x},${y}`);
  }
}

function walkerFor(gb: FakeOverworld) {
  return { press: (button: string, times = 1) => { for (let i = 0; i < times; i++) gb.press(button); } };
}

describe('learning where the walls are', () => {
  test('a wall is walked into once, then never again', () => {
    // The reported bug, as a test: DOWN is a fence. It must stop being an
    // option, rather than being guessed again every turn forever.
    const gb = new FakeOverworld(new Set(['5,6']));
    const world = emptyWorld();

    const first = walkStep(gb.asGameBoy(), walkerFor(gb), world, 'DOWN');
    assert.equal(first.moved, false);
    assert.equal(terrainAt(world, PALLET, 5, 6), 'wall', 'the fence is on the map now');

    // Nothing will ever route through it again.
    assert.equal(routeTo(world, PALLET, { x: 5, y: 5 }, { x: 5, y: 6 }), null);
    const reachable = frontiers(world, PALLET, { x: 5, y: 5 });
    assert.ok(
      !reachable.some((f) => f.x === 5 && f.y === 6),
      'and it is not offered as somewhere to go',
    );
  });

  test('turning is not mistaken for a wall', () => {
    // The trap: in Gen 1 the first press towards a new direction only turns
    // you. Calling that a wall would brick every corner in the game.
    const gb = new FakeOverworld(new Set());
    const world = emptyWorld();

    const result = walkStep(gb.asGameBoy(), walkerFor(gb), world, 'RIGHT');
    assert.equal(result.moved, true, 'the second press walks');
    assert.equal(terrainAt(world, PALLET, 6, 5), 'open');
  });

  test('a route is followed, and abandoned where it stops being true', () => {
    // Open corridor east, except (8,5) is a rock nobody knew about.
    const gb = new FakeOverworld(new Set(['8,5']));
    const world = emptyWorld();

    const report = followRoute(gb.asGameBoy(), walkerFor(gb), world, ['RIGHT', 'RIGHT', 'RIGHT', 'RIGHT']);

    assert.equal(report.taken, 2, 'walked to (7,5) and stopped at the rock');
    assert.equal(report.blockedAt, 'RIGHT');
    assert.equal(terrainAt(world, PALLET, 8, 5), 'wall');
    assert.equal(terrainAt(world, PALLET, 7, 5), 'open');
  });

  test('a door is remembered as a way out, not as a dead end', () => {
    const gb = new FakeOverworld(new Set(), 5, 5, new Map([['5,4', 37]]));
    const world = emptyWorld();

    const result = walkStep(gb.asGameBoy(), walkerFor(gb), world, 'UP');

    assert.equal(result.changedMap, true);
    const exits = exitsOf(world, PALLET);
    assert.equal(exits.length, 1);
    assert.deepEqual({ x: exits[0]!.x, y: exits[0]!.y }, { x: 5, y: 4 });
  });
});

describe('routing over ground we have walked', () => {
  test('finds a way around a wall instead of through it', () => {
    const world = emptyWorld();
    // A vertical wall at x=6 from the top edge down, with one gap at y=8.
    // It has to reach y=0 or the router will simply walk around the top — as
    // it should, and as it did when this test first had a shorter wall.
    for (let y = 0; y <= 14; y++) if (y !== 8) mark(world, PALLET, 'PALLET TOWN', 6, y, 'wall');
    for (let y = 0; y <= 14; y++) { mark(world, PALLET, 'PALLET TOWN', 5, y, 'open'); mark(world, PALLET, 'PALLET TOWN', 7, y, 'open'); }
    mark(world, PALLET, 'PALLET TOWN', 6, 8, 'open');

    const route = routeTo(world, PALLET, { x: 5, y: 5 }, { x: 7, y: 5 });

    assert.ok(route, 'there is a way round');
    // Straight through would be two steps; the only gap makes it eight.
    assert.equal(route.length, 8);
    // Replay it and check it never enters a wall.
    let at = { x: 5, y: 5 };
    for (const button of route) {
      const deltas: Record<string, [number, number]> = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
      at = { x: at.x + deltas[button]![0], y: at.y + deltas[button]![1] };
      assert.notEqual(terrainAt(world, PALLET, at.x, at.y), 'wall', `route walks into (${at.x},${at.y})`);
    }
    assert.deepEqual(at, { x: 7, y: 5 });
  });

  test('untried ground is assumed passable, or nothing could ever start', () => {
    const world = emptyWorld();
    mark(world, PALLET, 'PALLET TOWN', 5, 5, 'open');
    assert.ok(routeTo(world, PALLET, { x: 5, y: 5 }, { x: 5, y: 9 }), 'optimism is what makes a first step possible');
  });

  test('a walled-in player gets no route rather than a bad one', () => {
    const world = emptyWorld();
    mark(world, PALLET, 'PALLET TOWN', 5, 5, 'open');
    for (const [x, y] of [[4, 5], [6, 5], [5, 4], [5, 6]]) mark(world, PALLET, 'PALLET TOWN', x!, y!, 'wall');
    assert.equal(routeTo(world, PALLET, { x: 5, y: 5 }, { x: 9, y: 9 }), null);
  });
});

describe('what Jev is actually asked', () => {
  function stateAt(world = emptyWorld()) {
    const gb = new FakeOverworld(new Set());
    return { state: readGameState(gb.asGameBoy()), world };
  }

  test('the options are places, and none of them is a wall', () => {
    const { state, world } = stateAt();
    mark(world, PALLET, 'PALLET TOWN', 5, 5, 'open');
    mark(world, PALLET, 'PALLET TOWN', 5, 6, 'wall');

    const options = optionsFor(state, world, emptyJournal());
    const explore = options.filter((option) => option.destination.kind === 'explore');

    assert.ok(explore.length > 0, 'there is somewhere to go');
    for (const option of explore) {
      const destination = option.destination as { x: number; y: number; route: string[] };
      assert.notEqual(terrainAt(world, PALLET, destination.x, destination.y), 'wall');
      // Every route is walkable end to end; an option you cannot take is not one.
      let at = { x: 5, y: 5 };
      const deltas: Record<string, [number, number]> = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
      for (const button of destination.route) {
        at = { x: at.x + deltas[button]![0], y: at.y + deltas[button]![1] };
        assert.notEqual(terrainAt(world, PALLET, at.x, at.y), 'wall');
      }
    }
    // The south fence is gone from the choice entirely, not merely ranked low.
    assert.ok(!explore.some((o) => (o.destination as { y: number }).y === 6 && (o.destination as { x: number }).x === 5));
  });

  test('every option is described as a place, not a button', () => {
    const { state, world } = stateAt();
    for (const option of optionsFor(state, world, emptyJournal())) {
      assert.ok(option.description.length > 20, `too terse: ${option.description}`);
      assert.ok(!/^press (UP|DOWN|LEFT|RIGHT)/i.test(option.description));
    }
  });

  test('a known exit is offered with where it led', () => {
    const { state, world } = stateAt();
    mark(world, PALLET, 'PALLET TOWN', 5, 5, 'open');
    markExit(world, PALLET, 'PALLET TOWN', 5, 7, 37, "REDS HOUSE");

    const exits = optionsFor(state, world, emptyJournal()).filter((o) => o.destination.kind === 'exit');
    assert.equal(exits.length, 1);
    assert.match(exits[0]!.description, /REDS HOUSE/);
  });

  test('with no model, it heads for the nearest unexplored ground', () => {
    const { state, world } = stateAt();
    const chosen = fallbackDestination(optionsFor(state, world, emptyJournal()));
    assert.equal(chosen.destination.kind, 'explore');
    // Novelty-seeking cannot loop: the tile stops being unexplored once reached.
    const target = chosen.destination as { x: number; y: number };
    assert.equal(terrainAt(world, PALLET, target.x, target.y), undefined);
  });

  test('the choice stays small enough to be a choice', () => {
    const { state, world } = stateAt();
    assert.ok(optionsFor(state, world, emptyJournal()).length <= 8);
  });
});

describe('reading a bearing', () => {
  test('names the direction that dominates', () => {
    assert.equal(bearing(0, -5), 'north');
    assert.equal(bearing(5, 0), 'east');
    assert.equal(bearing(4, 4), 'south-east');
    assert.equal(bearing(1, 9), 'south', 'a nudge east of due south is still south');
  });
});

describe('a whole walk, end to end', () => {
  test('a boxed-in player explores the one way out instead of retrying the fence', () => {
    // Walls on three sides; the only opening is east. A button-guessing loop
    // spends its life on the other three.
    const walls = new Set(['5,4', '5,6', '4,5']);
    const gb = new FakeOverworld(walls);
    const world = emptyWorld();
    const walker = walkerFor(gb);

    for (let turn = 0; turn < 6; turn++) {
      const state = readGameState(gb.asGameBoy());
      const options = optionsFor(state, world, emptyJournal());
      const choice = fallbackDestination(options);
      if (!('route' in choice.destination)) break;
      followRoute(gb.asGameBoy(), walker, world, choice.destination.route);
    }

    const here = readGameState(gb.asGameBoy()).world;
    assert.ok(here.x > 5, `should have escaped east, ended at (${here.x},${here.y})`);
    const seen = explored(world, PALLET);
    assert.ok(seen.walls >= 1, 'and learned the fences on the way');
    assert.ok(seen.open >= 2, 'and the ground it covered');
  });
});
