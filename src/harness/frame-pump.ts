import { screenToPng } from '../emulator/png.ts';
import type { GameBoy } from '../emulator/gameboy.ts';
import type { JevEvents } from './events.ts';

/**
 * Decouples emulation speed from playback speed.
 *
 * The emulator runs far faster than real time and in bursts between model
 * calls, so pushing frames the instant they are produced makes the viewer look
 * like a slideshow of jump cuts. Instead we capture every other frame into a
 * queue and drain it at a steady 30fps, which plays back at roughly the speed
 * a human would see on real hardware. If the queue falls too far behind we
 * drop the backlog rather than lagging further.
 */
export class FramePump {
  #queue: string[] = [];
  #timer: NodeJS.Timeout | null = null;
  #captureEvery: number;
  #maxQueue: number;
  #frameCounter = 0;
  #speed = 1;

  constructor(
    private events: JevEvents,
    options: { captureEvery?: number; fps?: number; maxQueue?: number } = {},
  ) {
    this.#captureEvery = options.captureEvery ?? 2;
    this.#maxQueue = options.maxQueue ?? 90;
    this.#fps = options.fps ?? 30;
  }

  #fps: number;

  /**
   * Play at `multiplier` times normal speed.
   *
   * This is not a cosmetic setting. Frames are drained at a fixed rate, so
   * covering more game time per second means sampling more sparsely — and
   * sampling is the expensive part. Encoding a screenshot every other frame
   * costs roughly two and a half times as much as running the emulator that
   * produced it, so raising the multiplier makes the game genuinely run
   * faster as well as look faster.
   */
  setSpeed(multiplier: number): void {
    this.#speed = Math.max(1, Math.min(20, Math.round(multiplier)));
  }

  get speed(): number {
    return this.#speed;
  }

  /** Frames waiting to be sent; used to observe what was captured. */
  get queuedFrames(): number {
    return this.#queue.length;
  }

  /** Attach to an emulator so every frame is considered for capture. */
  attach(gb: GameBoy): void {
    gb.onFrame = (emulator) => {
      this.#frameCounter++;
      if (this.#frameCounter % (this.#captureEvery * this.#speed) !== 0) return;
      if (this.#queue.length >= this.#maxQueue) return; // viewer is behind; skip
      this.#queue.push(screenToPng(emulator.screen(), 1).toString('base64'));
    };
  }

  start(getFrameCount: () => number): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      // If we have built up more than a second of backlog, catch up.
      if (this.#queue.length > this.#fps) this.#queue.splice(0, this.#queue.length - this.#fps);
      const png = this.#queue.shift();
      if (png) this.events.emit('frame', { frame: getFrameCount(), png });
    }, Math.round(1000 / this.#fps));
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
