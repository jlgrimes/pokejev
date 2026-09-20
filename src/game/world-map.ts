import type { Button } from '../emulator/gameboy.ts';

/**
 * What Jev knows about the ground it has walked on.
 *
 * Every serious attempt at this problem converges on the same shape. The RL
 * work rewards reaching new tiles and new maps rather than pressing buttons;
 * the LLM harnesses stopped asking for button presses and gave the model a
 * destination-taking pathfinder plus a fog-of-war map built from memory reads,
 * precisely because models "attempt to walk into walls all the time".
 *
 * We have an advantage over a tool-calling agent: the option set is ours to
 * build. A tool can be ignored — and in Claude Plays Pokemon the navigation
 * tool largely was. A wall that is never offered as an option cannot be walked
 * into, however the model feels about it.
 *
 * Walkability is learned rather than read out of the ROM's tileset tables: we
 * press a direction and see whether the player moved. That needs no address we
 * might have wrong, and it is self-correcting — a tile wrongly marked is fixed
 * the next time we stand next to it.
 */

export type Terrain = 'open' | 'wall';

export interface MapKnowledge {
  name: string;
  /** "x,y" → what we found there. Absent means never tried. */
  tiles: Record<string, Terrain>;
  /** "x,y" → the map walking onto that tile led to. Doors, stairs, route edges. */
  exits: Record<string, { toMap: number; toName: string }>;
}

export interface WorldMemory {
  maps: Record<number, MapKnowledge>;
}

/** Cap on remembered tiles per map, so a long run cannot grow without bound. */
const MAX_TILES_PER_MAP = 4000;

export const STEPS: { button: Button; dx: number; dy: number }[] = [
  // y grows southward in Pokemon's coordinates, so UP is -1.
  { button: 'UP', dx: 0, dy: -1 },
  { button: 'DOWN', dx: 0, dy: 1 },
  { button: 'LEFT', dx: -1, dy: 0 },
  { button: 'RIGHT', dx: 1, dy: 0 },
];

export function emptyWorld(): WorldMemory {
  return { maps: {} };
}

const key = (x: number, y: number) => `${x},${y}`;

function mapFor(world: WorldMemory, map: number, name: string): MapKnowledge {
  const existing = world.maps[map];
  if (existing) return existing;
  const fresh: MapKnowledge = { name, tiles: {}, exits: {} };
  world.maps[map] = fresh;
  return fresh;
}

export function terrainAt(
  world: WorldMemory,
  map: number,
  x: number,
  y: number,
): Terrain | undefined {
  return world.maps[map]?.tiles[key(x, y)];
}

export function mark(
  world: WorldMemory,
  map: number,
  name: string,
  x: number,
  y: number,
  terrain: Terrain,
): void {
  const known = mapFor(world, map, name);
  // Standing somewhere proves it is open, and that outranks an earlier guess.
  if (terrain === 'wall' && known.tiles[key(x, y)] === 'open') return;
  if (!(key(x, y) in known.tiles) && Object.keys(known.tiles).length >= MAX_TILES_PER_MAP) return;
  known.tiles[key(x, y)] = terrain;
}

/** Remember that walking onto this tile changed maps — a door, or a route edge. */
export function markExit(
  world: WorldMemory,
  map: number,
  name: string,
  x: number,
  y: number,
  toMap: number,
  toName: string,
): void {
  const known = mapFor(world, map, name);
  known.tiles[key(x, y)] = 'open';
  known.exits[key(x, y)] = { toMap, toName };
}

export function exitsOf(world: WorldMemory, map: number): {
  x: number;
  y: number;
  toMap: number;
  toName: string;
}[] {
  const known = world.maps[map];
  if (!known) return [];
  return Object.entries(known.exits).map(([at, to]) => {
    const [x, y] = at.split(',').map(Number) as [number, number];
    return { x, y, ...to };
  });
}

export function step(x: number, y: number, button: Button): { x: number; y: number } {
  const move = STEPS.find((candidate) => candidate.button === button);
  return move ? { x: x + move.dx, y: y + move.dy } : { x, y };
}

/** How far we will search, in tiles. Gen 1 maps comfortably fit inside this. */
const SEARCH_RADIUS = 40;

/**
 * Shortest route from here to there, as buttons.
 *
 * Known walls are impassable; anything untried is assumed passable, because
 * assuming otherwise would make the first move on every new map impossible.
 * A wrong assumption costs one bumped step and is then remembered.
 */
export function routeTo(
  world: WorldMemory,
  map: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Button[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  const blocked = (x: number, y: number) => terrainAt(world, map, x, y) === 'wall';
  if (blocked(to.x, to.y)) return null;

  const start = key(from.x, from.y);
  const cameFrom = new Map<string, { prev: string; button: Button }>();
  const seen = new Set<string>([start]);
  let frontier = [{ x: from.x, y: from.y }];

  while (frontier.length > 0) {
    const next: { x: number; y: number }[] = [];
    for (const here of frontier) {
      for (const move of STEPS) {
        const x = here.x + move.dx;
        const y = here.y + move.dy;
        if (x < 0 || y < 0) continue;
        if (Math.abs(x - from.x) > SEARCH_RADIUS || Math.abs(y - from.y) > SEARCH_RADIUS) continue;
        const at = key(x, y);
        if (seen.has(at) || blocked(x, y)) continue;
        seen.add(at);
        cameFrom.set(at, { prev: key(here.x, here.y), button: move.button });
        if (x === to.x && y === to.y) return rebuild(cameFrom, start, at);
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  return null;
}

function rebuild(
  cameFrom: Map<string, { prev: string; button: Button }>,
  start: string,
  goal: string,
): Button[] {
  const route: Button[] = [];
  let at = goal;
  while (at !== start) {
    const hop = cameFrom.get(at);
    if (!hop) break;
    route.unshift(hop.button);
    at = hop.prev;
  }
  return route;
}

export interface Frontier {
  x: number;
  y: number;
  route: Button[];
  bearing: string;
  distance: number;
}

/**
 * The nearest places worth walking to: untried tiles next to ground we know.
 *
 * This is the exploration reward the RL work found necessary, turned into an
 * option set. One per compass bearing so the choice stays small and legible —
 * a list of forty nearby tiles is not a decision anyone can make.
 */
export function frontiers(
  world: WorldMemory,
  map: number,
  from: { x: number; y: number },
  limit = 4,
): Frontier[] {
  const known = world.maps[map];
  const blocked = (x: number, y: number) => known?.tiles[key(x, y)] === 'wall';
  const tried = (x: number, y: number) => key(x, y) in (known?.tiles ?? {});

  const found: Frontier[] = [];
  const seen = new Set<string>([key(from.x, from.y)]);
  const cameFrom = new Map<string, { prev: string; button: Button }>();
  let ring = [{ x: from.x, y: from.y }];
  let distance = 0;

  while (ring.length > 0 && distance < SEARCH_RADIUS && found.length < 24) {
    distance++;
    const next: { x: number; y: number }[] = [];
    for (const here of ring) {
      for (const move of STEPS) {
        const x = here.x + move.dx;
        const y = here.y + move.dy;
        if (x < 0 || y < 0) continue;
        const at = key(x, y);
        if (seen.has(at) || blocked(x, y)) continue;
        seen.add(at);
        cameFrom.set(at, { prev: key(here.x, here.y), button: move.button });
        if (!tried(x, y)) {
          found.push({
            x, y,
            route: rebuild(cameFrom, key(from.x, from.y), at),
            bearing: bearing(x - from.x, y - from.y),
            distance,
          });
        } else {
          // Only keep walking through ground we have already stood on.
          next.push({ x, y });
        }
      }
    }
    ring = next;
  }

  // One per bearing, nearest first: four real choices rather than forty.
  const perBearing = new Map<string, Frontier>();
  for (const candidate of found.sort((a, b) => a.distance - b.distance)) {
    if (!perBearing.has(candidate.bearing)) perBearing.set(candidate.bearing, candidate);
  }
  return [...perBearing.values()].slice(0, limit);
}

/** Plain-English direction, because "north" is easier to judge than "(4,-7)". */
export function bearing(dx: number, dy: number): string {
  const vertical = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
  const horizontal = dx < 0 ? 'west' : dx > 0 ? 'east' : '';
  // Only name both when neither dominates, so a mostly-north step reads "north".
  if (vertical && horizontal) {
    if (Math.abs(dy) > Math.abs(dx) * 2) return vertical;
    if (Math.abs(dx) > Math.abs(dy) * 2) return horizontal;
    return `${vertical}-${horizontal}`;
  }
  return vertical || horizontal || 'here';
}

/** How much of this map we have stood on — shown to a watcher, and to Jev. */
export function explored(world: WorldMemory, map: number): { open: number; walls: number } {
  const tiles = Object.values(world.maps[map]?.tiles ?? {});
  return {
    open: tiles.filter((terrain) => terrain === 'open').length,
    walls: tiles.filter((terrain) => terrain === 'wall').length,
  };
}
