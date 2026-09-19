import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from './gameboy.ts';

/**
 * Encode a Game Boy framebuffer as a PNG.
 *
 * `scale` matters more than it looks: the native 160x144 frame is small enough
 * that vision models struggle to read the in-game font, and nearest-neighbour
 * upscaling keeps the pixels crisp rather than blurring them.
 */
export function screenToPng(screen: number[], scale = 3): Buffer {
  const png = new PNG({ width: SCREEN_WIDTH * scale, height: SCREEN_HEIGHT * scale });
  for (let y = 0; y < SCREEN_HEIGHT * scale; y++) {
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < SCREEN_WIDTH * scale; x++) {
      const srcX = Math.floor(x / scale);
      const src = (srcY * SCREEN_WIDTH + srcX) * 4;
      const dst = (y * png.width + x) * 4;
      png.data[dst] = screen[src] ?? 0;
      png.data[dst + 1] = screen[src + 1] ?? 0;
      png.data[dst + 2] = screen[src + 2] ?? 0;
      png.data[dst + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

export function writeScreenPng(screen: number[], path: string, scale = 3): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, screenToPng(screen, scale));
}
