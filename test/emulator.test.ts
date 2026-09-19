import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GameBoy } from '../src/emulator/gameboy.ts';
import { screenToPng } from '../src/emulator/png.ts';
import { readScreenText } from '../src/game/screen.ts';
import { buildTestRom, TEST_ADDR } from './helpers/test-rom.ts';
import { FrameRecorder } from '../server/_lib/engine.ts';

function bootTestRom(): GameBoy {
  const gb = new GameBoy();
  gb.loadRom(buildTestRom());
  gb.advance(10);
  return gb;
}

describe('emulator harness', () => {
  test('runs a ROM and advances frames', () => {
    const gb = bootTestRom();
    assert.equal(gb.frameCount, 10);
    // The test ROM bumps a counter every loop, so a running CPU is non-zero.
    assert.notEqual(gb.readByte(TEST_ADDR.COUNTER), 0);
  });

  test('button presses reach the game', () => {
    const gb = bootTestRom();
    assert.equal(gb.readByte(TEST_ADDR.BUTTONS), 0);

    gb.press('A', { hold: 8, release: 0 });
    assert.equal(gb.readByte(TEST_ADDR.BUTTONS) & 0b0001, 0b0001, 'A should register');

    gb.advance(4);
    assert.equal(gb.readByte(TEST_ADDR.BUTTONS) & 0b0001, 0, 'A should release afterwards');

    gb.press('START', { hold: 8, release: 0 });
    assert.equal(gb.readByte(TEST_ADDR.BUTTONS) & 0b1000, 0b1000, 'START should register');
  });

  test('d-pad presses are distinct from buttons', () => {
    const gb = bootTestRom();
    gb.press('RIGHT', { hold: 8, release: 0 });
    assert.equal(gb.readByte(TEST_ADDR.DPAD) & 0b0001, 0b0001);
    assert.equal(gb.readByte(TEST_ADDR.BUTTONS), 0);

    gb.advance(4);
    gb.press('DOWN', { hold: 8, release: 0 });
    assert.equal(gb.readByte(TEST_ADDR.DPAD) & 0b1000, 0b1000);
  });

  test('several buttons can be held at once', () => {
    const gb = bootTestRom();
    gb.press(['A', 'B'], { hold: 8, release: 0 });
    assert.equal(gb.readByte(TEST_ADDR.BUTTONS) & 0b0011, 0b0011);
  });

  test('save states round-trip exactly', () => {
    const gb = bootTestRom();
    gb.advance(30);
    const snapshot = gb.saveState();
    const counterAtSnapshot = gb.readByte(TEST_ADDR.COUNTER);

    gb.advance(60);
    assert.notEqual(gb.readByte(TEST_ADDR.COUNTER), counterAtSnapshot);

    gb.loadState(snapshot);
    assert.equal(gb.readByte(TEST_ADDR.COUNTER), counterAtSnapshot);
    assert.equal(gb.frameCount, snapshot.frames);

    // And the emulator keeps running after a restore.
    gb.advance(5);
    assert.notEqual(gb.readByte(TEST_ADDR.COUNTER), counterAtSnapshot);
  });

  test('reads words big-endian, the way Pokemon stores HP', () => {
    const gb = bootTestRom();
    // The test ROM wrote 'H','E' (0x87, 0x84) at the start of the tile map.
    assert.equal(gb.readWord(TEST_ADDR.TILEMAP), 0x8784);
  });

  test('the frame hook fires once per frame', () => {
    const gb = bootTestRom();
    let count = 0;
    gb.onFrame = () => { count++; };
    gb.advance(12);
    assert.equal(count, 12);
  });

  test('produces a PNG of the screen', () => {
    const gb = bootTestRom();
    const png = screenToPng(gb.screen(), 2);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(png.length > 100);
  });
});

describe('screen text decoding', () => {
  test('reads the tile map as literal text', () => {
    const gb = bootTestRom();
    const screen = readScreenText(gb);

    assert.equal(screen.rows.length, 18);
    assert.ok(screen.rows[0]!.startsWith('HELLO'), `got ${JSON.stringify(screen.rows[0])}`);
    assert.ok(screen.flat.includes('HELLO'));
  });
});

describe('frame recording', () => {
  test('captures a short burst at full rate', () => {
    const gb = bootTestRom();
    const recorder = new FrameRecorder();
    recorder.attach(gb);
    gb.advance(60);
    const frames = recorder.finish(gb);

    // Every other frame, plus the closing still.
    assert.equal(recorder.stride, 2);
    assert.equal(frames.length, 31);
  });

  test('keeps a long tick bounded without dropping its ending', () => {
    const gb = bootTestRom();
    const recorder = new FrameRecorder();
    recorder.attach(gb);
    gb.advance(3000); // far more footage than the cap allows
    const frames = recorder.finish(gb);

    assert.ok(frames.length <= 241, `expected a bounded buffer, got ${frames.length}`);
    // Coverage is kept by sampling more coarsely, not by truncating early.
    assert.ok(recorder.stride > 2, `stride should have grown, was ${recorder.stride}`);
    assert.ok(frames.length > 100, 'should still return a watchable amount of footage');
  });

  test('always ends on the current screen', () => {
    const gb = bootTestRom();
    const recorder = new FrameRecorder();
    recorder.attach(gb);
    gb.advance(10);
    const frames = recorder.finish(gb);
    const last = Buffer.from(frames.at(-1)!, 'base64');
    assert.equal(last.subarray(1, 4).toString('ascii'), 'PNG');
  });
});
