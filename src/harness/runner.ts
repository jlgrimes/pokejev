import { setTimeout as sleep } from 'node:timers/promises';
import { GameBoy, type Button } from '../emulator/gameboy.ts';
import { Controller } from './controller.ts';
import { readGameState, type GameState } from '../game/state.ts';
import { analyzeBattle, type BattleAnalysis } from '../game/battle.ts';
import { nonEmptyLines } from '../game/screen.ts';
import { decideBattleAction } from '../jev/battle-agent.ts';
import { planOverworld } from '../jev/overworld-agent.ts';
import { screenToPng } from '../emulator/png.ts';
import type { JevConfig } from '../jev/model.ts';
import { addNote, addRecent, saveJournal, type Journal } from '../jev/journal.ts';
import { JevEvents, type DecisionEvent } from './events.ts';
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
    // Text boxes and animations do not need a model call — just keep the game moving.
    if (state.screen.awaitingInput && !state.ui.battleMenuOpen) {
      const presses = this.#controller.advanceText(6);
      this.#emitDecision({
        kind: 'auto',
        reasoning: 'A text box was waiting; advancing it does not need a decision.',
        action: `press A x${presses || 1}`,
        model: '(none)',
        usedFallback: false,
        latencyMs: 0,
        turn: this.#turns,
      });
      return;
    }

    if (state.battle && analysis) {
      if (state.ui.battleMenuOpen) {
        await this.#takeBattleTurn(state, analysis);
        return;
      }
      // Mid-battle animation or message: wait for the menu to come back.
      this.#controller.waitFor((screen) => screen.awaitingInput || screen.flat.includes('FIGHT'), 180);
      return;
    }

    await this.#takeOverworldTurn(state);
  }

  async #takeBattleTurn(state: GameState, analysis: BattleAnalysis): Promise<void> {
    const started = Date.now();
    const { decision, usedFallback } = await decideBattleAction(
      this.#config, state, analysis, this.#journal,
    );
    const latencyMs = Date.now() - started;

    let detail = '';
    let executed = false;

    if (decision.action === 'fight') {
      const move = analysis.moves.find((m) => m.index === decision.moveIndex) ?? analysis.moves[0];
      if (move) {
        detail = `${move.name} (~${move.damage.typical} dmg, ${move.effectivenessLabel})`;
        executed = this.#controller.useMove(move.name);
        this.#journal.stats.movesChosen++;
      }
    } else if (decision.action === 'switch' && decision.partySlot !== null) {
      const target = analysis.switchOptions.find((o) => o.slot === decision.partySlot);
      if (target) {
        detail = `switch to ${target.name}`;
        executed = this.#controller.switchTo(target.name);
      }
    } else if (decision.action === 'item' && decision.item) {
      detail = `use ${decision.item}`;
      executed = this.#controller.useItem(decision.item);
      if (executed && /BALL/i.test(decision.item)) this.#journal.stats.pokemonCaught++;
    } else if (decision.action === 'run') {
      detail = 'flee';
      executed = this.#controller.run();
    }

    if (!executed && decision.action !== 'fight') {
      // The menu path failed (item missing, switch refused); fall back to attacking.
      const best = analysis.moves.find((m) => m.pp > 0);
      if (best) {
        detail += ` → fell back to ${best.name}`;
        this.#controller.useMove(best.name);
      }
    }

    this.#emitDecision({
      kind: 'battle',
      reasoning: decision.reasoning,
      action: decision.action.toUpperCase(),
      detail,
      model: this.#config.battleModel,
      usedFallback,
      latencyMs,
      turn: this.#turns,
    });

    addRecent(this.#journal, `battle: ${decision.action} ${detail}`);
    if (decision.noteToSelf) addNote(this.#journal, decision.noteToSelf);

    // Let the turn play out: our move, their move, any fainting.
    this.#controller.advanceText(10);
  }

  async #takeOverworldTurn(state: GameState): Promise<void> {
    const started = Date.now();
    const screenshot = this.#config.vision
      ? screenToPng(this.#gb.screen(), 3)
      : undefined;

    const { plan, usedFallback } = await planOverworld(
      this.#config, state, this.#journal, screenshot,
    );
    const latencyMs = Date.now() - started;

    for (const input of plan.inputs) {
      this.#controller.press(input.button, input.repeat);
    }

    if (plan.goal && plan.goal !== this.#journal.goal) this.#journal.goal = plan.goal;
    if (plan.noteToSelf) addNote(this.#journal, plan.noteToSelf);

    const pressed = plan.inputs.map((i) => (i.repeat > 1 ? `${i.button}x${i.repeat}` : i.button)).join(' ');
    addRecent(this.#journal, `${state.world.mapName}: ${pressed} (${plan.observation})`);

    this.#emitDecision({
      kind: 'overworld',
      reasoning: plan.observation,
      action: pressed,
      detail: plan.goal,
      model: this.#config.model,
      usedFallback,
      latencyMs,
      turn: this.#turns,
    });
  }

  // --- plumbing ----------------------------------------------------------

  #analyze(state: GameState): BattleAnalysis | null {
    if (!state.battle) return null;
    return analyzeBattle(state.battle, state.world.party, { fairPlay: this.#config.fairPlay });
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
    this.events.emit('state', {
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
    });
  }

  #emitDecision(decision: DecisionEvent): void {
    this.events.emit('decision', decision);
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
