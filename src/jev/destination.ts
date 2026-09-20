import type { GameState } from '../game/state.ts';
import type { Button } from '../emulator/gameboy.ts';
import { frontiers, exitsOf, routeTo, bearing, explored, type WorldMemory } from '../game/world-map.ts';
import type { Journal } from './journal.ts';

/**
 * The overworld decision, rescoped.
 *
 * Asking "which button?" makes walking into a wall a legal answer, so it keeps
 * being given. Asking "where should we go?" cannot: every option here is a
 * real place with a real route to it, computed over ground we have actually
 * walked. A wall is not a destination, so it is never on the menu.
 *
 * This is the same move the working Pokemon harnesses made — replace button
 * presses with a destination-taking pathfinder — with one difference that
 * matters. Theirs was a tool the model could decline to use, and largely did.
 * Ours is the whole option set.
 */

export type Destination =
  | { kind: 'explore'; x: number; y: number; route: Button[]; bearing: string }
  | { kind: 'exit'; x: number; y: number; route: Button[]; toName: string }
  | { kind: 'interact' }
  | { kind: 'menu' }
  | { kind: 'back' };

export interface Option {
  key: string;
  description: string;
  destination: Destination;
}

/** Everything Jev may choose from here, and nothing it may not. */
export function optionsFor(
  state: GameState,
  world: WorldMemory,
  journal: Journal,
): Option[] {
  const options: Option[] = [];
  const here = { x: state.world.x, y: state.world.y };
  const map = state.world.map;

  for (const exit of exitsOf(world, map)) {
    const route = routeTo(world, map, here, exit);
    if (!route) continue; // no way there from here, so not a choice
    options.push({
      key: `exit:${exit.x},${exit.y}`,
      description:
        `Leave by the exit at (${exit.x},${exit.y}), ${route.length} steps ` +
        `${bearing(exit.x - here.x, exit.y - here.y)}. Last time it led to ${exit.toName}.`,
      destination: { kind: 'exit', x: exit.x, y: exit.y, route, toName: exit.toName },
    });
  }

  for (const frontier of frontiers(world, map, here)) {
    options.push({
      key: `explore:${frontier.x},${frontier.y}`,
      description:
        `Walk ${frontier.bearing} into ground nobody has stood on, ` +
        `${frontier.distance} step${frontier.distance === 1 ? '' : 's'} away at ` +
        `(${frontier.x},${frontier.y}).`,
      destination: {
        kind: 'explore',
        x: frontier.x,
        y: frontier.y,
        route: frontier.route,
        bearing: frontier.bearing,
      },
    });
  }

  options.push({
    key: 'interact',
    description:
      'Press A where you are standing: talk to whoever is in front of you, read the sign, ' +
      'or open what you are facing.',
    destination: { kind: 'interact' },
  });

  // Only worth offering once there is something in the menu to use.
  if (state.world.party.length > 0) {
    options.push({
      key: 'menu',
      description: 'Open the START menu — your party, your bag, and saving.',
      destination: { kind: 'menu' },
    });
  }

  if (state.menu.maxItem > 0 || state.screen.cursorRow >= 0) {
    options.push({
      key: 'back',
      description: 'Press B to back out of the menu that is open.',
      destination: { kind: 'back' },
    });
  }

  void journal;
  return options;
}

/** The structured state the decision is judged against. */
export function navigationState(
  state: GameState,
  world: WorldMemory,
  journal: Journal,
) {
  const seen = explored(world, state.world.map);
  return {
    situation: 'Choosing where to walk next in Pokemon Red',
    yourGoal: journal.goal,
    location: state.world.mapName,
    standingAt: { x: state.world.x, y: state.world.y },
    thisMapSoFar: `${seen.open} tiles walked, ${seen.walls} walls found`,
    knownExits: exitsOf(world, state.world.map).map((exit) => ({
      at: { x: exit.x, y: exit.y },
      leadsTo: exit.toName,
    })),
    badges: state.world.badges,
    party: state.world.party.map((mon) => ({
      name: mon.nickname || mon.species,
      level: mon.level,
      hpPercent: mon.hpPercent,
      status: mon.status,
    })),
    screenText: state.screen.rows.filter((row) => row.trim()),
    notesToSelf: journal.notes,
    whatYouJustDid: journal.recent,
  };
}

/**
 * What to do when there is no model, or the call failed.
 *
 * Nearest unexplored ground. The RL work found plain novelty-seeking gets an
 * agent a surprisingly long way, and unlike a button guess it never repeats
 * itself: the tile stops being unexplored the moment it is reached.
 */
export function fallbackDestination(options: Option[]): Option {
  const explore = options.filter((option) => option.destination.kind === 'explore');
  if (explore.length > 0) {
    return explore.reduce((best, option) =>
      routeLength(option) < routeLength(best) ? option : best,
    );
  }
  const exit = options.find((option) => option.destination.kind === 'exit');
  return exit ?? options.find((option) => option.key === 'interact') ?? options[0]!;
}

function routeLength(option: Option): number {
  const destination = option.destination;
  return 'route' in destination ? destination.route.length : Infinity;
}

/** One line for the viewer and the journal. */
export function describeDestination(destination: Destination): string {
  switch (destination.kind) {
    case 'explore':
      return `explore ${destination.bearing} to (${destination.x},${destination.y})`;
    case 'exit':
      return `head for the exit to ${destination.toName}`;
    case 'interact': return 'press A at what is in front';
    case 'menu': return 'open the menu';
    case 'back': return 'back out';
  }
}
