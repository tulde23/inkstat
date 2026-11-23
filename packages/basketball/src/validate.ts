import type { Game, Issue, Side, TeamSheet } from './types';

export interface ValidationRules {
  /** Fouls before a player fouls out (5 in most US high school / youth leagues, 6 in NBA). */
  foulLimit: number;
}

export const DEFAULT_RULES: ValidationRules = { foulLimit: 5 };

const sum = (xs: (number | null)[]) =>
  xs.every((x) => x !== null) ? (xs as number[]).reduce((a, b) => a + b, 0) : null;

/**
 * Basketball arithmetic gives free cross-checks on what the model read.
 * Every disagreement becomes an Issue pointing at the cell to look at.
 */
export function validateTeam(team: TeamSheet, side: Side, rules = DEFAULT_RULES): Issue[] {
  const issues: Issue[] = [];
  const at = (path: string) => `${side}.${path}`;

  team.players.forEach((p, i) => {
    const row = `players.${i}`;
    const who = p.number ? `#${p.number}` : p.name ?? `row ${i + 1}`;
    if (!p.number && !p.name) {
      issues.push({ severity: 'warning', path: at(`${row}.number`), message: `Row ${i + 1} has no number or name` });
    }
    if (p.ftMade !== null && p.ftAttempted !== null && p.ftMade > p.ftAttempted) {
      issues.push({
        severity: 'error',
        path: at(`${row}.ftMade`),
        message: `${who}: ${p.ftMade} free throws made but only ${p.ftAttempted} attempted`,
      });
    }
    if (p.fouls !== null && p.fouls > rules.foulLimit) {
      issues.push({
        severity: 'warning',
        path: at(`${row}.fouls`),
        message: `${who}: ${p.fouls} fouls is over the ${rules.foulLimit}-foul limit`,
      });
    }
    const own = p.periodPoints?.length ? sum(p.periodPoints) : null;
    if (p.points !== null && own !== null && own !== p.points) {
      issues.push({
        severity: 'warning',
        path: at(`${row}.points`),
        message: `${who}: quarter columns add up to ${own}, but points say ${p.points}`,
      });
    }
    if (p.points !== null && p.fg2 !== null && p.fg3 !== null && p.ftMade !== null) {
      const expected = 2 * p.fg2 + 3 * p.fg3 + p.ftMade;
      if (expected !== p.points) {
        issues.push({
          severity: 'warning',
          path: at(`${row}.points`),
          message: `${who}: baskets and free throws add up to ${expected}, but points say ${p.points}`,
        });
      }
    }
  });

  const numbers = new Map<string, number>();
  team.players.forEach((p, i) => {
    if (!p.number) return;
    const prev = numbers.get(p.number);
    if (prev !== undefined) {
      issues.push({
        severity: 'warning',
        path: at(`players.${i}.number`),
        message: `#${p.number} appears twice (rows ${prev + 1} and ${i + 1})`,
      });
    } else numbers.set(p.number, i);
  });

  const playerTotal = sum(team.players.map((p) => p.points));
  const periodTotal = sum(team.periodScores);
  if (team.totalPoints !== null && playerTotal !== null && team.players.length && playerTotal !== team.totalPoints) {
    issues.push({
      severity: 'warning',
      path: at('totalPoints'),
      message: `Player points add up to ${playerTotal}, but the final score says ${team.totalPoints}`,
    });
  }
  // Some points unread: the known ones can't be checked exactly, but falling short of
  // the final is still worth saying; it usually means rows were missed or left blank.
  if (team.totalPoints !== null && playerTotal === null && team.players.length) {
    const known = team.players.reduce((n, p) => n + (p.points ?? 0), 0);
    const blank = team.players.filter((p) => p.points === null).length;
    if (known < team.totalPoints) {
      issues.push({
        severity: 'warning',
        path: at('totalPoints'),
        message:
          `Player points found so far add up to ${known} of ${team.totalPoints}` +
          ` (${blank} player${blank === 1 ? ' has' : 's have'} no points read). Some rows may be missing.`,
      });
    }
  }
  if (team.totalPoints !== null && periodTotal !== null && periodTotal !== team.totalPoints) {
    issues.push({
      severity: 'warning',
      path: at('periodScores'),
      message: `Period scores add up to ${periodTotal}, but the final score says ${team.totalPoints}`,
    });
  }
  // Books with a column per quarter: every player's quarter points should add up
  // to the team's score for that quarter.
  if (team.players.some((p) => p.periodPoints?.length)) {
    team.periodScores.forEach((score, q) => {
      if (score === null) return;
      const col = team.players.map((p) => p.periodPoints?.[q] ?? null);
      const known = col.filter((v): v is number => v !== null);
      if (!known.length) return;
      const got = known.reduce((a, b) => a + b, 0);
      const label = periodLabel(q);
      // Blank cells are usually players who did not score that quarter, so only
      // a total above the box is certain; below it is worth a look when all were read.
      if (got > score || (got < score && known.length === col.length)) {
        issues.push({
          severity: 'warning',
          path: at(`periodScores.${q}`),
          message: `Player points in the ${label} add up to ${got}, but the ${label} box says ${score}`,
        });
      }
    });
  }
  const runningScore = team.runningScore ?? null;
  if (runningScore !== null && team.totalPoints !== null && runningScore !== team.totalPoints) {
    issues.push({
      severity: 'warning',
      path: at('runningScore'),
      message: `The running score stops at ${runningScore}, but the final score says ${team.totalPoints}`,
    });
  }
  const halfScore = team.halfScore ?? null;
  const [q1, q2] = team.periodScores;
  if (halfScore !== null && q1 != null && q2 != null && q1 + q2 !== halfScore) {
    issues.push({
      severity: 'warning',
      path: at('halfScore'),
      message: `The first two quarters add up to ${q1 + q2}, but the half-time score says ${halfScore}`,
    });
  }
  if (team.totalPoints === null) {
    issues.push({ severity: 'warning', path: at('totalPoints'), message: 'Final score is missing' });
  }
  return issues;
}

/** "1st quarter" … "4th quarter", then "overtime" / "2nd overtime". */
function periodLabel(q: number): string {
  const nth = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  if (q < 4) return `${nth(q + 1)} quarter`;
  return q === 4 ? 'overtime' : `${nth(q - 3)} overtime`;
}

/**
 * Whether this team's page was read (or its players entered). A scorekeeper may scan
 * only their own team's page; the other side then holds at most a name and a score
 * typed in, and there is nothing on it to check.
 */
export const wasRead = (team: TeamSheet): boolean => team.pageUri !== null || team.players.length > 0;

export function validateGame(game: Game, rules = DEFAULT_RULES): Issue[] {
  return (['home', 'away'] as const).flatMap((side) => (wasRead(game[side]) ? validateTeam(game[side], side, rules) : []));
}

/** Final score for a team: the written total, else the sum of player points. */
export function teamScore(team: TeamSheet): number | null {
  return team.totalPoints ?? sum(team.players.map((p) => p.points));
}
