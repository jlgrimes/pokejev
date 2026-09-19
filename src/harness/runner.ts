import { setTimeout as sleep } from 'node:timers/promises';
import { GameBoy, type Button } from '../emulator/gameboy.ts';
import { Controller } from './controller.ts';
import { readGameState, type GameState } from '../game/state.ts';
import type { BattleAnalysis } from '../game/battle.ts';
import { takeTurn, analyzeIfBattle } from './turn.ts';
import type { JevConfig } from '../jev/model.ts';
import { saveJournal, type Journal } from '../jev/journal.ts';
import { JevEvents, buildStateEvent } from './events.ts';
import { FramePump } from './frame-pump.ts';
import type { ViewerControls } from '../viewer/server.ts';

export interface RunnerOptions {
  gb: GameBoy;
  config: JevConfig;
  journal: Journal;
  journalPath: string;
  events?: JevEvents;
  /** Stop after this many decisions. Infinity by default. */
  maxTurns?: number;
  /** Write an emulator save state every N turns. */
  autosaveEvery?: number;
  autosavePath?: string;
  /** Start paused, so a viewer can be opened before anything happens. */
  startPaused?: boolean;
}

/**
 * The play loop: observe, decide, act, repeat.
 *
 * Two things keep this cheap and stable. First, anything that does not need
 * judgement (advancing text boxes, waiting out animations) is handled without a
 * model call. Second, every action is followed by re-reading RAM, so a
 * mis-press is corrected on the next turn instead of compounding.
 */
export class JevRunner implements ViewerControls {
  readonly events: JevEvents;
  #gb: GameBoy;
  #controller: Controller;
  #config: JevConfig;
  #journal: Journal;
  #options: RunnerOptions;
  #pump: FramePump;

  #paused: boolean;
  #stepRequested = false;
  #stopped = false;
  #inputQueue: Button[] = [];
  #turns = 0;
  #wasInBattle = false;

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#gb = options.gb;
    this.#config = options.config;
    this.#journal = options.journal;
    this.events = options.events ?? new JevEvents();
    this.#controller = new Controller(options.gb);
    this.#paused = options.startPaused ?? false;
    this.#pump = new FramePump(this.events);
    this.#pump.attach(options.gb);
  }

  // --- viewer controls ---------------------------------------------------
  pause(): void { this.#paused = true; this.#emitStatus(); }
  resume(): void { this.#paused = false; this.#emitStatus(); }
  step(): void { this.#stepRequested = true; this.#paused = false; this.#emitStatus(); }
  isPaused(): boolean { return this.#paused; }
  stop(): void { this.#stopped = true; this.#pump.stop(); }
  queueInput(button: Button): void { this.#inputQueue.push(button); }

  get journal(): Journal { return this.#journal; }
  get turns(): number { return this.#turns; }

  async run(): Promise<void> {
    this.#pump.start(() => this.#gb.frameCount);
    this.#emitStatus();
    const maxTurns = this.#options.maxTurns ?? Infinity;

    while (!this.#stopped && this.#turns < maxTurns) {
      await this.#waitWhilePaused();
      if (this.#stopped) break;

      this.#applyManualInputs();

      const state = readGameState(this.#gb);
      const analysis = this.#analyze(state);
      this.#emitState(state, analysis);
      this.#trackBattleTransitions(state);

      await this.#takeTurn(state, analysis);

      this.#turns++;
      this.#journal.stats.turns = this.#turns;
      this.#emitStatus();

      if (this.#stepRequested) {
        this.#stepRequested = false;
        this.#paused = true;
        this.#emitStatus();
      }

      const autosaveEvery = this.#options.autosaveEvery ?? 25;
      if (this.#turns % autosaveEvery === 0) this.#autosave();

      // Yield so the viewer's socket flushes and controls stay responsive.
      await sleep(0);
    }

    this.#autosave();
    this.#pump.stop();
  }

  // --- turn handling -----------------------------------------------------

  async #takeTurn(state: GameState, analysis: BattleAnalysis | null): Promise<void> {
    const outcome = await takeTurn({
      gb: this.#gb,
      controller: this.#controller,
      config: this.#config,
      journal: this.#journal,
      state,
      analysis,
    });
    this.events.emit('decision', { ...outcome, turn: this.#turns });
  }

  // --- plumbing ----------------------------------------------------------

  #analyze(state: GameState): BattleAnalysis | null {
    return analyzeIfBattle(state, this.#config);
  }

  #trackBattleTransitions(state: GameState): void {
    const inBattle = state.battle !== null;
    if (inBattle && !this.#wasInBattle) {
      this.#journal.stats.battlesEntered++;
      this.events.log('info', `Battle started against ${state.battle?.enemy.species}`);
    }
    if (!inBattle && this.#wasInBattle) {
      this.#journal.stats.battlesWon++;
      this.events.log('info', 'Battle ended');
    }
    this.#wasInBattle = inBattle;
  }

  #applyManualInputs(): void {
    while (this.#inputQueue.length > 0) {
      const button = this.#inputQueue.shift()!;
      this.#controller.press(button);
      this.events.log('info', `Manual input: ${button}`);
    }
  }

  async #waitWhilePaused(): Promise<void> {
    while (this.#paused && !this.#stopped) {
      this.#applyManualInputs();
      // Keep emulating so the screen stays live while paused.
      this.#gb.advance(2);
      await sleep(30);
    }
  }

  #emitState(state: GameState, analysis: BattleAnalysis | null): void {
    this.events.emit('state', buildStateEvent(state, analysis));
  }

  #emitStatus(): void {
    this.events.emit('status', {
      running: !this.#stopped,
      paused: this.#paused,
      turns: this.#turns,
      goal: this.#journal.goal,
      notes: this.#journal.notes,
      stats: this.#journal.stats as unknown as Record<string, number>,
    });
  }

  #autosave(): void {
    saveJournal(this.#options.journalPath, this.#journal);
    if (this.#options.autosavePath) {
      try {
        this.#gb.writeStateFile(this.#options.autosavePath);
      } catch (error) {
        this.events.log('warn', `Could not write save state: ${(error as Error).message}`);
      }
    }
  }
}
