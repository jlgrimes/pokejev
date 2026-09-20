import { gzipSync, gunzipSync } from 'node:zlib';
import { GameBoy, type SaveState } from '../../src/emulator/gameboy.ts';
import { loadRom } from './rom.ts';
import { getStorage } from './storage.ts';
import { emptyJournal, type Journal } from '../../src/jev/journal.ts';

export interface SessionData {
  version: 1;
  /** Emulator snapshot with the ROM stripped out — see GameBoy.saveState. */
  snapshot: SaveState;
  journal: Journal;
  turns: number;
  updatedAt: string;
}

const sessionKey = (id: string) => `sessions/${id}.json.gz`;

export function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Rebuild the Game Boy for one request.
 *
 * This is the heart of running an emulator on stateless infrastructure: the
 * ROM comes from cache, the snapshot comes from storage, and the machine is
 * reconstituted mid-battle exactly as the last tick left it.
 */
export async function openSession(
  id: string,
): Promise<{ gb: GameBoy; journal: Journal; turns: number; isNew: boolean }> {
  const rom = await loadRom();
  const gb = new GameBoy();
  gb.loadRom(rom);

  const stored = await getStorage().read(sessionKey(id));
  if (!stored) {
    // A fresh run: only the boot animations. The title screen and the
    // new-game menus are driven by the play loop, which checks the screen
    // after every press rather than assuming a fixed sequence landed.
    gb.advance(400);
    return { gb, journal: emptyJournal(), turns: 0, isNew: true };
  }

  const data = JSON.parse(gunzipSync(stored).toString('utf8')) as SessionData;
  gb.loadState(data.snapshot);
  return {
    gb,
    journal: { ...emptyJournal(), ...data.journal },
    turns: data.turns,
    isNew: false,
  };
}

export async function saveSession(
  id: string,
  gb: GameBoy,
  journal: Journal,
  turns: number,
): Promise<number> {
  const data: SessionData = {
    version: 1,
    snapshot: gb.saveState({ includeRom: false }),
    journal,
    turns,
    updatedAt: new Date().toISOString(),
  };
  const packed = gzipSync(Buffer.from(JSON.stringify(data)));
  await getStorage().write(sessionKey(id), packed, 'application/gzip');
  return packed.length;
}

export async function deleteSession(id: string): Promise<void> {
  await getStorage().remove(sessionKey(id));
}
