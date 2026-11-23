import { seasonTotals, type SeasonLine } from './stats';
import type { Game, Side, TeamSheet } from './types';
import { teamScore, wasRead } from './validate';

/**
 * InkStat keeps the book for one team: yours. A team has a name you choose
 * ("Beacon Hill JV Girls 2026") and the names scorekeepers write on the sheet
 * ("BEACON", "BH"), which are only used to find your team on a scanned page.
 */
export interface MyTeam {
  id: string;
  name: string;
  /** Names on the scoresheet, as written. Learned when you confirm which team is yours. */
  aliases: string[];
  createdAt: number;
  updatedAt: number;
}

export type Outcome = 'W' | 'L' | 'T';

/** "Beacon Hill", "BEACON HILL." and "beacon-hill" are one name. */
export const nameKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Whether a name on the sheet is this team: its own name, or one of the names it goes by. */
export function isMyTeamName(sheetName: string | null | undefined, team: MyTeam): boolean {
  const key = sheetName ? nameKey(sheetName) : '';
  if (!key) return false;
  return [team.name, ...team.aliases].some((n) => nameKey(n) === key);
}

export const other = (side: Side): Side => (side === 'home' ? 'away' : 'home');

/**
 * Which side of a scanned game is your team.
 * - `side`: sure. `learn` is a sheet name to remember for next time (only when it was inferred).
 * - `ask`: can't tell; ask "Which team is yours?".
 */
export function findMySide(game: Game, team: MyTeam): { side: Side; learn: string | null } | { ask: true } {
  const home = isMyTeamName(game.home.name, team);
  const away = isMyTeamName(game.away.name, team);
  if (home !== away) return { side: home ? 'home' : 'away', learn: null };
  if (home && away) return { ask: true };
  // No name matched. One page scanned: a scorekeeper scans their own team's page.
  const read = (['home', 'away'] as const).filter((s) => wasRead(game[s]));
  if (read.length === 1) return { side: read[0], learn: game[read[0]].name?.trim() || null };
  return { ask: true };
}

/** Adds a sheet name to the team's names, unless it already matches. */
export function learnName(team: MyTeam, sheetName: string | null | undefined, now = Date.now()): MyTeam {
  const name = sheetName?.trim();
  if (!name || isMyTeamName(name, team)) return team;
  return { ...team, aliases: [...team.aliases, name], updatedAt: now };
}

/** Marks the game as this team's, on `side`. */
export const assignGame = (game: Game, team: MyTeam, side: Side, now = Date.now()): Game => ({
  ...game,
  teamId: team.id,
  mine: side,
  updatedAt: now,
});

/**
 * A side's final as recorded: its score box, or its players' points when its page was read.
 * Null when neither is known: an unscanned opponent never counts as scoring 0.
 */
export const opponentScore = (sheet: TeamSheet): number | null =>
  sheet.totalPoints ?? (sheet.players.length ? teamScore(sheet) : null);

/** Your result in one game; outcome is null until both scores are known. */
export interface MyResult {
  game: Game;
  us: number | null;
  them: number | null;
  opponent: string | null;
  outcome: Outcome | null;
}

export function myResult(game: Game): MyResult | null {
  if (!game.mine) return null;
  const us = opponentScore(game[game.mine]);
  const them = opponentScore(game[other(game.mine)]);
  const outcome: Outcome | null = us === null || them === null ? null : us > them ? 'W' : us < them ? 'L' : 'T';
  return { game, us, them, opponent: game[other(game.mine)].name?.trim() || null, outcome };
}

const when = (g: Game) => `${g.date ?? ''}|${String(g.createdAt).padStart(15, '0')}`;

export interface TeamSeason {
  wins: number;
  losses: number;
  ties: number;
  /** Current run, e.g. { kind: 'W', count: 3 }; null before the first result. */
  streak: { kind: Outcome; count: number } | null;
  /** Points a game, over games with both scores. */
  pointsFor: number;
  pointsAgainst: number;
  /** Newest first, every game of this team (with or without a result). */
  results: MyResult[];
}

/** Record, streak and points for one team's games (any other games are ignored). */
export function teamSeason(games: Game[], teamId: string): TeamSeason {
  const results = games
    .filter((g) => g.teamId === teamId && g.mine)
    .sort((a, b) => when(b).localeCompare(when(a)))
    .map((g) => myResult(g)!);
  const decided = results.filter((r) => r.outcome);
  let streak: TeamSeason['streak'] = null;
  for (const r of decided) {
    if (!streak) streak = { kind: r.outcome!, count: 1 };
    else if (streak.kind === r.outcome) streak.count++;
    else break;
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  return {
    wins: decided.filter((r) => r.outcome === 'W').length,
    losses: decided.filter((r) => r.outcome === 'L').length,
    ties: decided.filter((r) => r.outcome === 'T').length,
    streak,
    pointsFor: avg(decided.map((r) => r.us!)),
    pointsAgainst: avg(decided.map((r) => r.them!)),
    results,
  };
}

/**
 * Season lines for your players only, across this team's games. The sheet may spell
 * the team differently from game to game, so players are matched under the team's own name.
 */
export function myPlayers(games: Game[], team: MyTeam): SeasonLine[] {
  const mine = games
    .filter((g) => g.teamId === team.id && g.mine)
    .map((g) => ({ ...g, home: { ...g[g.mine!], name: team.name }, away: { ...g[other(g.mine!)], players: [] } }));
  return seasonTotals(mine, team.name);
}

/** Every distinct team name on these games' sheets, most games first: suggestions for "which team is yours?". */
export function sheetNames(games: Game[]): string[] {
  const counts = new Map<string, { name: string; n: number }>();
  for (const g of games) {
    for (const s of [g.home, g.away]) {
      const name = s.name?.trim();
      if (!name) continue;
      const k = nameKey(name);
      if (!k) continue;
      const c = counts.get(k) ?? { name, n: 0 };
      c.n++;
      counts.set(k, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((c) => c.name);
}

/** Links every unassigned game where one side carries one of the team's names. */
export function claimGames(games: Game[], team: MyTeam, now = Date.now()): Game[] {
  const out: Game[] = [];
  for (const g of games) {
    if (g.teamId) continue;
    const found = findMySide(g, team);
    // Only a name match claims an old game; "only one page was read" is for a fresh scan.
    if ('side' in found && found.learn === null) out.push(assignGame(g, team, found.side, now));
  }
  return out;
}
