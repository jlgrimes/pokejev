import { EventEmitter } from 'node:events';
import type { GameState } from '../game/state.ts';
import type { BattleAnalysis } from '../game/battle.ts';
import { nonEmptyLines } from '../game/screen.ts';

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
  kind: 'battle' | 'overworld' | 'auto';
  reasoning: string;
  action: string;
  detail?: string;
  model: string;
  usedFallback: boolean;
  latencyMs: number;
  turn: number;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface StatusEvent {
  running: boolean;
  paused: boolean;
  turns: number;
  goal: string;
  notes: string[];
  stats: Record<string, number>;
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

/** Typed bus connecting the runner to any number of viewers. */
export class JevEvents extends EventEmitter<JevEventMap> {
  log(level: LogEvent['level'], message: string): void {
    this.emit('log', { level, message });
  }
}
