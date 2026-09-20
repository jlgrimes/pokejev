import { EventEmitter } from 'node:events';
import type { GameState } from '../game/state.ts';
import type { BattleAnalysis } from '../game/battle.ts';
import { nonEmptyLines } from '../game/screen.ts';
import type { Consideration } from '../jev/evaluate-agent.ts';
import { exitsOf, type WorldMemory } from '../game/world-map.ts';

export interface FrameEvent {
  frame: number;
  /** base64-encoded PNG of the current screen. */
  png: string;
}

export interface StateEvent {
  frame: number;
  mode: GameState['mode'];
  location: string;
  position: { x: number; y: number };
  money: number;
  badges: string[];
  party: {
    name: string;
    species: string;
    level: number;
    hp: number;
    maxHp: number;
    hpPercent: number;
    status: string;
  }[];
  screen: string[];
  /** A fog-of-war view of the current map: what Jev has walked and bumped into. */
  map: {
    name: string;
    at: { x: number; y: number };
    open: [number, number][];
    walls: [number, number][];
    exits: { x: number; y: number; to: string }[];
  } | null;
  battle: {
    kind: string;
    enemy: string;
    enemyLevel: number;
    enemyHpPercent: number;
    active: string;
    activeHpPercent: number;
    analysis: BattleAnalysis | null;
  } | null;
}

export interface DecisionEvent {
  kind: 'battle' | 'overworld' | 'auto' | 'intro' | 'stuck';
  reasoning: string;
  action: string;
  detail?: string;
  model: string;
  usedFallback: boolean;
  latencyMs: number;
  turn: number;
  /** What Jev weighed, when it decided as an evaluation model. */
  considered?: Consideration[];
  /** Consecutive turns that changed nothing on screen. */
  stuckFor?: number;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface StatusEvent {
  running: boolean;
  paused: boolean;
  turns: number;
  /** Playback multiplier; also how sparsely frames are sampled. */
  speed?: number;
  goal: string;
  notes: string[];
  stats: Record<string, number>;
  /** Consecutive turns that changed nothing, so a watcher can see a wedge. */
  stuckFor?: number;
}

export interface JevEventMap {
  frame: [FrameEvent];
  state: [StateEvent];
  decision: [DecisionEvent];
  log: [LogEvent];
  status: [StatusEvent];
}

/**
 * Flatten a game state into the payload viewers consume.
 *
 * Shared by the local SSE runner and the deployed tick endpoint so the browser
 * renders the same shape no matter which one it is talking to.
 */
export function buildStateEvent(
  state: GameState,
  analysis: BattleAnalysis | null,
  world?: WorldMemory,
): StateEvent {
  return {
    frame: state.frame,
    mode: state.mode,
    location: state.world.mapName,
    position: { x: state.world.x, y: state.world.y },
    money: state.world.money,
    badges: state.world.badges,
    party: state.world.party.map((mon) => ({
      name: mon.nickname || mon.species,
      species: mon.species,
      level: mon.level,
      hp: mon.hp,
      maxHp: mon.maxHp,
      hpPercent: mon.hpPercent,
      status: mon.status,
    })),
    screen: nonEmptyLines(state.screen),
    map: buildMapView(state, world),
    battle: state.battle
      ? {
          kind: state.battle.kind,
          enemy: state.battle.enemy.species,
          enemyLevel: state.battle.enemy.level,
          enemyHpPercent: state.battle.enemy.hpPercent,
          active: state.battle.player.nickname || state.battle.player.species,
          activeHpPercent: state.battle.player.hpPercent,
          analysis,
        }
      : null,
  };
}

/**
 * The map as a watcher sees it.
 *
 * Every harness that got anywhere with this game gave the model a fog-of-war
 * map built from memory rather than pixels. Drawing the same thing for the
 * person watching means a wall Jev keeps bumping into is visible as a wall,
 * instead of being something you have to infer from a stalled turn counter.
 */
function buildMapView(state: GameState, world?: WorldMemory): StateEvent['map'] {
  const known = world?.maps[state.world.map];
  if (!known) return null;
  const split = (want: string) =>
    Object.entries(known.tiles)
      .filter(([, terrain]) => terrain === want)
      .map(([at]) => at.split(',').map(Number) as [number, number]);
  return {
    name: state.world.mapName,
    at: { x: state.world.x, y: state.world.y },
    open: split('open'),
    walls: split('wall'),
    exits: exitsOf(world!, state.world.map).map((exit) => ({ x: exit.x, y: exit.y, to: exit.toName })),
  };
}

/** Typed bus connecting the runner to any number of viewers. */
export class JevEvents extends EventEmitter<JevEventMap> {
  log(level: LogEvent['level'], message: string): void {
    this.emit('log', { level, message });
  }
}
