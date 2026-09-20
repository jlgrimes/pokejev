import type { GameBoy, Button } from '../emulator/gameboy.ts';
import { readGameState } from '../game/state.ts';
import { mark, markExit, step, type WorldMemory } from '../game/world-map.ts';

/**
 * Walking, with the result of every step written down.
 *
 * The bug this exists to kill: press DOWN, do not move, press DOWN again
 * forever. Nothing in a button-per-turn loop can tell "walked south" from
 * "bumped into a fence", so the same answer stays available and stays wrong.
 *
 * Here a step is closed-loop — press, re-read the coordinates, record what
 * happened — and a tile that did not give is remembered as a wall, so the
 * planner stops routing through it and the model is never offered it again.
 */

export interface StepResult {
  moved: boolean;
  /** Walking onto that tile put us somewhere else entirely: a door or an edge. */
  changedMap: boolean;
  /** A battle, a text box or a menu appeared; the route is over. */
  interrupted: boolean;
}

export interface Walker {
  press(button: Button, times?: number): void;
}

/**
 * Take one step, and learn from it.
 *
 * Pressed twice when the first press does not move us, because Gen 1 spends
 * the first press turning to face a new direction. Only a direction that fails
 * twice is a wall — treating the turn as a wall would brick every corner.
 */
export function walkStep(
  gb: GameBoy,
  walker: Walker,
  world: WorldMemory,
  button: Button,
): StepResult {
  const before = readGameState(gb);
  const target = step(before.world.x, before.world.y, button);

  for (let attempt = 0; attempt < 2; attempt++) {
    walker.press(button);
    const after = readGameState(gb);

    if (after.world.map !== before.world.map) {
      markExit(
        world,
        before.world.map,
        before.world.mapName,
        target.x,
        target.y,
        after.world.map,
        after.world.mapName,
      );
      mark(world, after.world.map, after.world.mapName, after.world.x, after.world.y, 'open');
      return { moved: true, changedMap: true, interrupted: true };
    }

    if (after.world.x !== before.world.x || after.world.y !== before.world.y) {
      mark(world, before.world.map, before.world.mapName, after.world.x, after.world.y, 'open');
      return {
        moved: true,
        changedMap: false,
        interrupted: after.battle !== null || after.screen.awaitingInput,
      };
    }

    // Did not move, but something took over the screen — stop, do not conclude
    // anything about the tile. A text box is not a wall.
    if (after.battle !== null || after.screen.awaitingInput) {
      return { moved: false, changedMap: false, interrupted: true };
    }
  }

  mark(world, before.world.map, before.world.mapName, target.x, target.y, 'wall');
  return { moved: false, changedMap: false, interrupted: false };
}

export interface WalkReport {
  taken: number;
  planned: number;
  blockedAt: Button | null;
  changedMap: boolean;
  interrupted: boolean;
}

/**
 * Follow a planned route, abandoning it the moment reality disagrees.
 *
 * Routes go stale — a wall turns up, a trainer starts a battle, a door opens
 * somewhere new. Re-planning next turn from what we just learned is cheaper
 * and more honest than pressing the rest of a plan that no longer applies.
 */
export function followRoute(
  gb: GameBoy,
  walker: Walker,
  world: WorldMemory,
  route: Button[],
  maxSteps = 12,
): WalkReport {
  const planned = Math.min(route.length, maxSteps);
  let taken = 0;

  // Standing here proves this tile is open, which seeds an empty map.
  const start = readGameState(gb);
  mark(world, start.world.map, start.world.mapName, start.world.x, start.world.y, 'open');

  for (const button of route.slice(0, maxSteps)) {
    const result = walkStep(gb, walker, world, button);
    if (result.moved) taken++;
    if (result.changedMap) {
      return { taken, planned, blockedAt: null, changedMap: true, interrupted: true };
    }
    if (!result.moved && !result.interrupted) {
      return { taken, planned, blockedAt: button, changedMap: false, interrupted: false };
    }
    if (result.interrupted) {
      return { taken, planned, blockedAt: null, changedMap: false, interrupted: true };
    }
  }

  return { taken, planned, blockedAt: null, changedMap: false, interrupted: false };
}
