import { resultsFor, type ExtractionRun } from '@inkstat/ocr-engine';

import { REGION, detailRegion } from './scorebook';
import { emptyTeam, type PlayerLine, type TeamSheet } from './types';

/** Short keys from template.ts (each key repeats on every row, so short keys save real time). */
interface RawPlayer {
  no: string | null;
  name: string | null;
  tp: number | null;
  f: number | null;
  // Not asked for since template v5, but kept so older/other templates still map.
  p2?: number | null;
  p3?: number | null;
  ftm?: number | null;
  fta?: number | null;
}

/**
 * Many scorebooks write the score by period as a running total (15, 26, 39, 50)
 * rather than points per period (15, 11, 13, 11). If the numbers never go
 * down and don't already add up to the final, treat them as running totals.
 */
export function perPeriodScores(
  written: (number | null)[],
  final: number | null,
): { scores: (number | null)[]; wasCumulative: boolean } {
  // An empty or zeroed overtime box (Ø) means no overtime; it would otherwise
  // break the "never goes down" test for running totals.
  let end = written.length;
  while (end > 4 && (written[end - 1] === null || written[end - 1] === 0)) end--;
  if (end < written.length) {
    const r = perPeriodScores(written.slice(0, end), final);
    return { scores: [...r.scores, ...written.slice(end)], wasCumulative: r.wasCumulative };
  }
  const filled = written.filter((n): n is number => n !== null);
  const lastFilled = written.reduce<number>((at, n, i) => (n !== null ? i : at), -1);
  const contiguous = lastFilled >= 1 && written.slice(0, lastFilled + 1).every((n) => n !== null);
  const nonDecreasing = filled.every((n, i) => i === 0 || n >= filled[i - 1]);
  const sum = filled.reduce((a, b) => a + b, 0);
  const lastValue = filled[filled.length - 1];
  const looksCumulative =
    contiguous && nonDecreasing && sum !== final && (final === null || lastValue <= final);
  if (!looksCumulative) return { scores: written, wasCumulative: false };
  const scores = written.map((n, i) => {
    if (n === null || i > lastFilled) return n;
    return i === 0 ? n : n - (written[i - 1] as number);
  });
  return { scores, wasCumulative: true };
}

/**
 * Models often copy the Final box onto the end of the period list
 * (15, 26, 39, 50, Ø, 50). Past the four quarters, a trailing blank, 0, or a
 * repeat of the final is not an overtime period.
 */
export function dropFinalFromPeriods(periods: (number | null)[], final: number | null): (number | null)[] {
  const out = [...periods];
  while (out.length > 4) {
    const last = out[out.length - 1];
    if (last === null || last === 0 || (final !== null && last === final)) out.pop();
    else break;
  }
  return out;
}

interface RawSummary {
  team_name: string | null;
  opponent: string | null;
  date: string | null;
  location: string | null;
  period_scores: (number | null)[];
  final_score: number | null;
  timeouts_used: number | null;
}

export interface PageReading {
  team: TeamSheet;
  opponent: string | null;
  date: string | null;
  location: string | null;
  /** Regions the model failed on entirely. */
  failures: string[];
  /** Automatic corrections worth telling the user about. */
  notes: string[];
}

const filled = (p: PlayerLine) =>
  [p.number, p.name, p.fouls, p.fg2, p.fg3, p.ftMade, p.ftAttempted, p.points].filter((v) => v !== null)
    .length;

/** Rows seen in two overlapping strips are the same player; key on number, else name. */
function playerKey(p: PlayerLine): string | null {
  const num = p.number?.replace(/[^0-9]/g, '');
  if (num) return `#${Number(num)}`;
  const name = p.name?.toLowerCase().replace(/[^a-z]/g, '');
  return name ? `n:${name}` : null;
}

/** Printed labels a model may copy into the name column (seen on the Stars sheet: "Running Score"). */
const FORM_LABEL =
  /^(running score|player scoring|player|players|name|team|team fouls?|coach|timeouts?|totals?|score by (quarters|periods)|fouls|no\.?)$/i;

export function isPlayerName(name: string | null): boolean {
  if (!name) return false;
  const n = name.trim();
  return n.length > 0 && !/^[\d\s.,-]+$/.test(n) && !FORM_LABEL.test(n);
}

/** A name cut short by the model ("D...", "Drex…"): the row was probably cut by a strip edge. */
const truncated = (p: PlayerLine) => /(\.\.\.|…)\s*$/.test(p.name ?? '');

/**
 * Rows seen in two overlapping strips are the same player. Which copy to keep:
 * a row cut off at the bottom edge of a strip (`edge`) or with a truncated name
 * loses to a whole one; otherwise the copy with more cells read.
 */
export function mergePlayers(rows: PlayerLine[], edge: ReadonlySet<PlayerLine> = new Set()): PlayerLine[] {
  const out: PlayerLine[] = [];
  const index = new Map<string, number>();
  const worse = (p: PlayerLine) => (edge.has(p) ? 1 : 0) + (truncated(p) ? 1 : 0);
  for (const row of rows) {
    if (filled(row) === 0) continue;
    const key = playerKey(row);
    const at = key ? index.get(key) : undefined;
    if (at === undefined) {
      if (key) index.set(key, out.length);
      out.push(row);
      continue;
    }
    const kept = out[at];
    const better = worse(row) !== worse(kept) ? worse(row) < worse(kept) : filled(row) > filled(kept);
    if (better) out[at] = { ...row, readNotes: [...kept.readNotes, ...row.readNotes] };
  }
  return out;
}

/** Turn one page's extraction into a TeamSheet plus header details. */
export function readPage(run: ExtractionRun): PageReading {
  const team = emptyTeam();
  team.pageUri = run.sourceUri;
  const failures: string[] = [];

  const notes: string[] = [];
  const [summary] = resultsFor(run, 'summary');
  const s = summary?.data as RawSummary | null;
  if (summary) team.crops.push({ regionId: 'summary', uri: summary.imageUri });
  if (summary && !s) failures.push('summary');

  // Marked boxes are read up close, so each one beats the whole-page summary.
  const boxed = <T,>(regionId: string): T | null => {
    const [r] = resultsFor(run, regionId);
    if (!r) return null;
    team.crops.push({ regionId, uri: r.imageUri });
    if (!r.data) failures.push(regionId.replace('_', ' '));
    return (r.data as T | null) ?? null;
  };
  type Details = { team_name?: string | null; opponent?: string | null; coach?: string | null; location?: string | null; date?: string | null };
  const details: Details = {
    ...(boxed<Details>(REGION.details) ?? {}),
    ...(boxed<Details>(detailRegion('teamName')) ?? {}),
    ...(boxed<Details>(detailRegion('opponent')) ?? {}),
    ...(boxed<Details>(detailRegion('coach')) ?? {}),
    ...(boxed<Details>(detailRegion('location')) ?? {}),
    ...(boxed<Details>(detailRegion('date')) ?? {}),
  };
  const quarters = boxed<{ period_scores: (number | null)[]; final_score: number | null }>(REGION.quarters);
  const timeouts = boxed<{ timeouts_used: number | null }>(REGION.timeouts);
  const teamFouls = boxed<{ team_fouls: (number | null)[] }>(REGION.teamFouls);
  const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

  team.name = text(details?.team_name) ?? s?.team_name ?? null;
  team.coach = text(details?.coach);
  const scoreSource = quarters ?? s;
  if (scoreSource) {
    const { scores, wasCumulative } = perPeriodScores(
      dropFinalFromPeriods(scoreSource.period_scores ?? [], scoreSource.final_score),
      scoreSource.final_score,
    );
    if (wasCumulative) notes.push('Score by period was written as running totals; converted to points per period.');
    // An overtime box holding 0 (often a slashed Ø) means no overtime was played.
    const periods = scores.filter((n, i) => i < 4 || (n !== null && n !== 0));
    team.periodScores = [...periods, ...Array(Math.max(0, 4 - periods.length)).fill(null)];
    team.totalPoints = scoreSource.final_score;
  }
  const finalBox = boxed<{ final_score: number | null }>(REGION.finalScore);
  if (finalBox?.final_score != null) team.totalPoints = finalBox.final_score;
  const halfBox = boxed<{ half_score: number | null }>(REGION.halfScore);
  team.halfScore = halfBox?.half_score ?? null;
  team.timeoutsUsed = timeouts ? timeouts.timeouts_used : (s?.timeouts_used ?? null);
  team.teamFouls = teamFouls?.team_fouls ?? [];

  const rows: PlayerLine[] = [];
  const edgeRows = new Set<PlayerLine>();
  for (const tile of resultsFor(run, 'players')) {
    tile.imageUris.forEach((uri, k) =>
      team.crops.push({
        regionId: `players-${tile.tileIndex + 1}${tile.imageUris.length > 1 ? String.fromCharCode(97 + k) : ''}`,
        uri,
      }),
    );
    const players = (tile.data as { players: RawPlayer[] } | null)?.players;
    if (!players) {
      failures.push(`players strip ${tile.tileIndex + 1}`);
      continue;
    }
    players.forEach((p, i) => {
      const row: PlayerLine = {
        number: p.no,
        name: p.name,
        fouls: p.f,
        fg2: p.p2 ?? null,
        fg3: p.p3 ?? null,
        ftMade: p.ftm ?? null,
        ftAttempted: p.fta ?? null,
        points: p.tp,
        readNotes: tile.warnings
          .filter((w) => w.startsWith(`$.players[${i}]`))
          .map((w) => w.replace(/^\$\.players\[\d+\]\./, '')),
      };
      rows.push(row);
      // The last row of a strip that isn't the last strip sits on the cut edge.
      if (i === players.length - 1 && tile.tileIndex < tile.tileCount - 1) edgeRows.add(row);
    });
  }
  team.players = mergePlayers(rows, edgeRows);

  // Fouls come from their own read of names | fouls; match rows by jersey number.
  const foulRows = resultsFor(run, REGION.fouls).flatMap((tile) => {
    team.crops.push({ regionId: `${REGION.fouls}-${tile.tileIndex + 1}`, uri: tile.imageUri });
    return (tile.data as { players: { no: string | null; f: number | null }[] } | null)?.players ?? [];
  });
  if (foulRows.length) {
    const digits = (v: string | null) => (v ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    const fouls = new Map<string, number | null>();
    for (const r of foulRows) {
      const k = digits(r.no);
      if (k && (r.f !== null || !fouls.has(k))) fouls.set(k, r.f);
    }
    for (const p of team.players) {
      const k = digits(p.number);
      if (k && fouls.has(k)) p.fouls = fouls.get(k) ?? null;
    }
  }

  // Player tables always have names. Nameless rows next to named ones are almost
  // always numbers picked up from a nearby grid (running score, team fouls).
  // A "name" that is only digits, or a printed form label, is not a player.
  const named = team.players.filter((p) => isPlayerName(p.name));
  if (named.length >= 3 && named.length < team.players.length) {
    notes.push(`Dropped ${team.players.length - named.length} row(s) with no player name.`);
    team.players = named;
  }

  // Fill a missing points column from the marks when every part is known.
  for (const p of team.players) {
    if (p.points === null && p.fg2 !== null && p.fg3 !== null && p.ftMade !== null) {
      p.points = 2 * p.fg2 + 3 * p.fg3 + p.ftMade;
      p.readNotes.push('points computed from baskets and free throws');
    }
  }

  // Models confuse "Played at: Henley" with the opponent; a name equal to the location isn't an opponent.
  const location = text(details?.location) ?? s?.location ?? null;
  const sameText = (a: string | null, b: string | null) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const rawOpponent = text(details.opponent) ?? s?.opponent ?? null;
  const opponent = sameText(rawOpponent, location) ? null : rawOpponent;

  return { team, opponent, date: text(details?.date) ?? s?.date ?? null, location, failures, notes };
}

/** Best-effort date normalization to yyyy-mm-dd; returns null when unsure. */
export function normalizeDate(raw: string | null, fallbackYear = new Date().getFullYear()): string | null {
  if (!raw) return null;
  const iso = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return fmt(+iso[1], +iso[2], +iso[3]);
  const us = raw.match(/(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/);
  if (!us) return null;
  let year = us[3] ? +us[3] : fallbackYear;
  if (year < 100) year += 2000;
  return fmt(year, +us[1], +us[2]);
}

/** Today on this phone's calendar (local time, not UTC), as yyyy-mm-dd. */
export function today(now: Date = new Date()): string {
  return fmt(now.getFullYear(), now.getMonth() + 1, now.getDate())!;
}

function fmt(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
