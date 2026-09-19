import type { GameState } from '../game/state.ts';
import type { BattleAnalysis } from '../game/battle.ts';
import type { Journal } from './journal.ts';
import { nonEmptyLines } from '../game/screen.ts';
import { BATTLE_ITEMS } from '../game/data/items.ts';

export const JEV_IDENTITY = `You are Jev, an AI playing Pokemon Red on a real Game Boy emulator.
You are a competent, decisive player: you know Generation 1 mechanics, you read the
screen carefully, and you commit to a plan rather than dithering.

Things that are true about Generation 1 specifically, and that you should not get wrong:
- A move is physical or special purely because of its TYPE, not per move.
- Ghost moves do NOTHING to Psychic types (this is the famous Gen 1 quirk).
- Psychic is dominant; very little resists it.
- There is no Dark or Steel type, and no Special Attack/Defense split.
- Badge boosts, stat stages and status conditions matter a lot.
- Struggle is what you get when every move is out of PP; avoid running dry.`;

function formatParty(state: GameState): string {
  if (state.world.party.length === 0) return 'Party: (empty)';
  return [
    'Party:',
    ...state.world.party.map((mon) => {
      const name = mon.nickname && mon.nickname !== mon.species ? `${mon.nickname} (${mon.species})` : mon.species;
      const types = mon.types.filter((t) => t !== 'UNKNOWN').join('/');
      const moves = mon.moves.map((m) => `${m.name} ${m.pp}pp`).join(', ') || 'no moves';
      return `  [${mon.slot}] ${name} L${mon.level} ${mon.hp}/${mon.maxHp}HP (${mon.hpPercent}%) ${types} ${mon.status !== 'OK' ? `STATUS: ${mon.status}` : ''}
       moves: ${moves}`;
    }),
  ].join('\n');
}

/** The battle briefing: precomputed numbers first, so Jev judges rather than does arithmetic. */
export function formatBattleBriefing(
  state: GameState,
  analysis: BattleAnalysis,
  journal: Journal,
  options: { fairPlay?: boolean } = {},
): string {
  const battle = state.battle!;
  const { player, enemy } = battle;

  const enemyLine = options.fairPlay
    ? `${enemy.species} L${enemy.level}, roughly ${enemy.hpPercent}% HP, ${enemy.status}`
    : `${enemy.species} L${enemy.level} ${enemy.hp}/${enemy.maxHp}HP (${enemy.hpPercent}%), ${enemy.status}, ` +
      `types ${enemy.types.filter((t) => t !== 'UNKNOWN').join('/')}, ` +
      `stats atk ${enemy.stats?.attack} def ${enemy.stats?.defense} spd ${enemy.stats?.speed} spc ${enemy.stats?.special}`;

  const moveLines = analysis.moves.map((move) => {
    const flags = [
      move.power === 0 ? 'status move' : move.effectivenessLabel,
      move.guaranteedKo ? 'GUARANTEED KO' : move.possibleKo ? 'can KO' : '',
      move.pp === 0 ? 'OUT OF PP — unusable' : '',
      ...move.notes,
    ].filter(Boolean);
    return `  [${move.index}] ${move.name} (${move.type}, power ${move.power}, acc ${move.accuracy ?? '—'}, ${move.pp}pp) → ~${move.damage.typical} dmg (${move.damage.min}-${move.damage.max}), ${Math.round(move.damage.fractionOfTargetHp * 100)}% of its HP | ${flags.join('; ')}`;
  });

  const threatLines = analysis.incoming.length
    ? analysis.incoming.map(
        (threat) =>
          `  ${threat.move} (${threat.type}) → ~${threat.damage.typical} dmg to you (${threat.damage.min}-${threat.damage.max})${threat.canKo ? ' — CAN KNOCK YOU OUT' : ''}`,
      )
    : ['  (unknown — you have not seen its moves yet)'];

  const stages = (s: typeof player.statStages) =>
    Object.entries(s)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
      .join(', ') || 'none';

  return `BATTLE (${battle.kind}${battle.variant !== 'normal' ? `, ${battle.variant}` : ''})

YOUR ACTIVE POKEMON
  ${player.nickname || player.species} L${player.level} ${player.hp}/${player.maxHp}HP (${player.hpPercent}%), ${player.status}
  types ${player.types.filter((t) => t !== 'UNKNOWN').join('/')}
  stat stages: ${stages(player.statStages)}

OPPONENT
  ${enemyLine}
  stat stages: ${stages(enemy.statStages)}

SPEED: ${analysis.fasterSide === 'player' ? 'you move first' : analysis.fasterSide === 'enemy' ? 'the opponent moves first' : 'speed tie'} (${analysis.playerSpeed} vs ${analysis.enemySpeed})

YOUR MOVES (damage already calculated with the real Gen 1 formula, stat stages and STAB included)
${moveLines.join('\n')}

WHAT THE OPPONENT CAN DO TO YOU
${threatLines.join('\n')}
  You can survive roughly ${analysis.turnsToSurvive === Infinity ? 'many' : analysis.turnsToSurvive} more turns at that rate.${analysis.inKoRange ? '\n  DANGER: you are in knockout range right now.' : ''}

SWITCH OPTIONS
${analysis.switchOptions.length ? analysis.switchOptions.map((o) => `  [${o.slot}] ${o.name} ${o.hpPercent}% — ${o.note}`).join('\n') : '  (nobody healthy on the bench)'}
${analysis.catchChance !== null ? `\nCATCH: a POKE BALL right now has roughly a ${Math.round(analysis.catchChance * 100)}% chance (weakening it and inflicting sleep/paralysis raises this a lot).` : ''}

${formatParty(state)}

BAG: ${state.world.bag
    .map((b) => `${b.item} x${b.count}${BATTLE_ITEMS[b.item] ? ` (${BATTLE_ITEMS[b.item]})` : ''}`)
    .join(', ') || '(empty)'}

YOUR CURRENT GOAL: ${journal.goal}

SCREEN:
${nonEmptyLines(state.screen).map((line) => `  | ${line}`).join('\n')}`;
}

/** The overworld briefing: where we are, what's on screen, what we were doing. */
export function formatOverworldBriefing(state: GameState, journal: Journal): string {
  return `OVERWORLD

LOCATION: ${state.world.mapName} (map id ${state.world.map}) at tile x=${state.world.x}, y=${state.world.y}
PLAYER: ${state.world.playerName || '(unnamed)'} | money ¥${state.world.money} | badges: ${state.world.badges.join(', ') || 'none'}

${formatParty(state)}

BAG: ${state.world.bag.map((b) => `${b.item} x${b.count}`).join(', ') || '(empty)'}

SCREEN (exact text read from the tile map; ▶ is the menu cursor, ▼ means a text box is waiting):
${nonEmptyLines(state.screen).map((line) => `  | ${line}`).join('\n') || '  (no text on screen)'}
${state.menu.maxItem > 0 ? `\nMENU: cursor is on entry ${state.menu.cursorIndex} of 0..${state.menu.maxItem}` : ''}

YOUR CURRENT GOAL: ${journal.goal}

NOTES YOU HAVE WRITTEN DOWN:
${journal.notes.length ? journal.notes.map((n) => `  - ${n}`).join('\n') : '  (none yet)'}

WHAT YOU JUST DID:
${journal.recent.length ? journal.recent.map((r) => `  - ${r}`).join('\n') : '  (nothing yet)'}`;
}
