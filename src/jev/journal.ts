import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Jev's memory between turns.
 *
 * A model call only sees what we hand it, so without this the agent would
 * rediscover its own goal every few seconds and walk in circles. Kept small on
 * purpose: a goal, durable notes, and a short rolling log.
 */
export interface Journal {
  goal: string;
  notes: string[];
  recent: string[];
  stats: {
    turns: number;
    battlesEntered: number;
    battlesWon: number;
    movesChosen: number;
    pokemonCaught: number;
  };
}

const MAX_NOTES = 25;
const MAX_RECENT = 12;

export function emptyJournal(): Journal {
  return {
    goal: 'Get out of the house, meet PROF.OAK, and pick a starter Pokemon.',
    notes: [],
    recent: [],
    stats: { turns: 0, battlesEntered: 0, battlesWon: 0, movesChosen: 0, pokemonCaught: 0 },
  };
}

export function loadJournal(path: string): Journal {
  if (!existsSync(path)) return emptyJournal();
  try {
    return { ...emptyJournal(), ...(JSON.parse(readFileSync(path, 'utf8')) as Journal) };
  } catch {
    return emptyJournal();
  }
}

export function saveJournal(path: string, journal: Journal): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(journal, null, 2));
}

export function addNote(journal: Journal, note: string): void {
  const trimmed = note.trim();
  if (!trimmed || journal.notes.includes(trimmed)) return;
  journal.notes.push(trimmed);
  if (journal.notes.length > MAX_NOTES) journal.notes.shift();
}

export function addRecent(journal: Journal, entry: string): void {
  journal.recent.push(entry);
  if (journal.recent.length > MAX_RECENT) journal.recent.shift();
}
