import { randomUUID } from 'node:crypto';

import { seasonFor } from '@inkstat/basketball';

import type { DB } from './db';
import { ApiError } from './errors';
import type { SharedLayout } from './sanitize';

/**
 * The shared registry scorekeepers build as they go: teams (with aliases and merges),
 * which scorebook template each team uses, and final scores. Nothing here holds a
 * player's name: rosters live only inside groups (see rosters below).
 */

export type Level = 'varsity' | 'jv' | 'freshman' | 'middle' | 'youth' | 'college' | 'adult' | 'other';
export type Gender = 'boys' | 'girls' | 'men' | 'women' | 'coed';

export interface TeamInput {
  sport: string;
  name: string;
  school?: string | null;
  town?: string | null;
  state?: string | null;
  level: Level;
  gender: Gender;
}

export interface Team extends Required<Omit<TeamInput, 'school' | 'town' | 'state'>> {
  id: string;
  school: string | null;
  town: string | null;
  state: string | null;
  aliases: string[];
}

/** Votes from different scorekeepers before two teams merge. */
export const MERGE_VOTES = 2;

const STOP = new Set(['the', 'high', 'school', 'hs', 'academy', 'boys', 'girls', 'basketball', 'varsity', 'jv']);

/** "St. Mary's High School" -> "st marys". Accents and punctuation go; filler words go. */
export function normalizeName(s: string): string {
  const words = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length ? kept : words).join(' ');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const dedupeKey = (t: TeamInput) =>
  [t.sport, t.level, t.gender, normalizeName(t.name), normalizeName(t.town ?? ''), (t.state ?? '').toUpperCase()].join('|');

interface TeamRow {
  id: string;
  sport: string;
  name: string;
  norm: string;
  school: string | null;
  town: string | null;
  state: string | null;
  level: Level;
  gender: Gender;
  merged_into: string | null;
}

export interface ResultInput {
  sport: string;
  date: string;
  homeId: string;
  awayId: string;
  /** Either score may be null (a scorekeeper who read only one team's page), not both. */
  homeScore?: number | null;
  awayScore?: number | null;
  periods?: { home?: (number | null)[] | null; away?: (number | null)[] | null } | null;
  /** The app's own id for the scanned game: tells a re-report apart from a doubleheader. */
  sourceId?: string | null;
}

/**
 * partial: a side nobody has reported yet, nothing conflicting. reported: both sides known,
 * no side backed by two scorekeepers. confirmed: both known, nothing conflicting, and at
 * least one side backed by two or more scorekeepers who agree. disputed: a side conflicts.
 */
export type ResultStatus = 'partial' | 'reported' | 'confirmed' | 'disputed';

/** What the reports say about one side: nobody gave it, they agree, or they don't. */
export type SideState = 'unknown' | 'known' | 'conflicting';

export interface ResultSide {
  id: string;
  name: string;
  /** Null when unknown. When conflicting, the latest report's score stands in. */
  score: number | null;
  state: SideState;
  /** Reports that give this side's score. */
  reports: number;
}

export interface Result {
  id: string;
  sport: string;
  season: string;
  date: string;
  home: ResultSide;
  away: ResultSide;
  status: ResultStatus;
  reports: number;
}

/** Both scores known and not disputed: the results standings and the public scoreboard count. */
export const isFinal = (r: Result) => r.status === 'reported' || r.status === 'confirmed';

interface ReportRow {
  user_id: string;
  home_score: number | null;
  away_score: number | null;
  reported_at: number;
  source_id: string | null;
}

interface ResultRow {
  id: string;
  sport: string;
  season: string;
  date: string;
  home_id: string;
  away_id: string;
  created_at: number;
}

interface Side {
  state: SideState;
  score: number | null;
  values: Set<number>;
  reports: number;
}

/** Combines one side's scores across reports (ordered oldest first). */
function combineSide(scores: (number | null)[]): Side {
  const given = scores.filter((v): v is number => v !== null);
  const values = new Set(given);
  if (!given.length) return { state: 'unknown', score: null, values, reports: 0 };
  return { state: values.size > 1 ? 'conflicting' : 'known', score: given[given.length - 1], values, reports: given.length };
}

const DAY = 86_400_000;
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** What the public scoreboard shows of a team: its name and where it plays. */
export interface PublicTeam {
  id: string;
  name: string;
  town: string | null;
  state: string | null;
  level: Level;
  gender: Gender;
}

export interface PublicResult {
  id: string;
  date: string;
  home: { id: string; score: number | null };
  away: { id: string; score: number | null };
  /** Partial games are left off the public scoreboard. */
  status: Exclude<ResultStatus, 'partial'>;
}

export interface RosterPlayer {
  number: string | null;
  name: string | null;
}

interface TemplateRow {
  id: string;
  sport: string;
  name: string;
  layout: string;
  created_at: number;
  updated_at: number;
}

interface GroupTemplateRow {
  group_id: string;
  template_id: string;
  shared_by: string | null;
  sharer_name: string | null;
  shared_at: number;
  updated_at: number;
  deleted: number;
  seq: number;
  layout: string;
  created_at: number;
  template_updated_at: number;
}

/** A template as the app stores it (version 3), rebuilt from a shared layout. Never a photo. */
export interface DownloadedTemplate extends SharedLayout {
  version: 3;
  id: string;
  photoUri: null;
  test: null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupTemplateChange {
  id: string;
  deleted: boolean;
  updatedAt: number;
  seq: number;
  data: DownloadedTemplate | null;
  sharedBy: { userId: string | null; name: string | null } | null;
  sharedAt: number | null;
  /** The caller shared it. */
  mine: boolean;
}

/** Live templates a group can hold at once. */
export const MAX_GROUP_TEMPLATES = 200;
const MAX_BROWSE = 100;

const asDownloaded = (r: { id: string; layout: string; created_at: number; updated_at: number }): DownloadedTemplate => {
  const l = JSON.parse(r.layout) as SharedLayout;
  return {
    version: 3,
    id: r.id,
    sport: l.sport,
    name: l.name,
    enabled: l.enabled,
    parts: l.parts,
    variants: l.variants ?? {},
    photoUri: null,
    ...(l.anchors ? { anchors: l.anchors } : {}),
    ...(l.builtinId ? { builtinId: l.builtinId } : {}),
    ...(l.sheet ? { sheet: l.sheet } : {}),
    test: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

export function createRegistry(db: DB, now: () => number = Date.now) {
  const q = {
    team: db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE id = ?'),
    byKey: db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE dedupe_key = ?'),
    insertTeam: db.prepare(
      `INSERT INTO teams (id, sport, name, norm, school, town, state, level, gender, dedupe_key, created_by, created_at, updated_at)
       VALUES (@id, @sport, @name, @norm, @school, @town, @state, @level, @gender, @key, @by, @at, @at)`,
    ),
    aliases: db.prepare<[string], { alias: string }>('SELECT alias FROM team_aliases WHERE team_id = ? ORDER BY alias'),
    addAlias: db.prepare('INSERT OR IGNORE INTO team_aliases (team_id, alias_norm, alias) VALUES (?, ?, ?)'),
    search: db.prepare<[string, string, string, string], TeamRow>(
      `SELECT DISTINCT t.* FROM teams t LEFT JOIN team_aliases a ON a.team_id = t.id
       WHERE t.sport = ? AND t.merged_into IS NULL AND (t.norm LIKE ? OR a.alias_norm LIKE ? OR t.town LIKE ?)
       LIMIT 200`,
    ),
    similar: db.prepare<[string, string, string], TeamRow>(
      'SELECT * FROM teams WHERE sport = ? AND level = ? AND gender = ? AND merged_into IS NULL LIMIT 2000',
    ),
    vote: db.prepare('INSERT OR IGNORE INTO merge_votes (from_id, into_id, user_id, created_at) VALUES (?, ?, ?, ?)'),
    votes: db.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM merge_votes WHERE from_id = ? AND into_id = ?'),
    markMerged: db.prepare('UPDATE teams SET merged_into = ?, updated_at = ? WHERE id = ?'),
    moveAliases: db.prepare('INSERT OR IGNORE INTO team_aliases (team_id, alias_norm, alias) SELECT ?, alias_norm, alias FROM team_aliases WHERE team_id = ?'),
    moveTemplates: db.prepare('INSERT OR IGNORE INTO team_templates (team_id, template_id, user_id, used_at) SELECT ?, template_id, user_id, used_at FROM team_templates WHERE team_id = ?'),
    moveGroupTeams: db.prepare('INSERT OR IGNORE INTO group_teams (group_id, team_id, added_by) SELECT group_id, ?, added_by FROM group_teams WHERE team_id = ?'),
    resultsOf: db.prepare<[string, string], { id: string; home_id: string; away_id: string; date: string; sport: string }>(
      'SELECT id, home_id, away_id, date, sport FROM results WHERE home_id = ? OR away_id = ?',
    ),
    setSides: db.prepare('UPDATE results SET home_id = ?, away_id = ? WHERE id = ?'),
    resultBy: db.prepare<[string, string, string, string, string], { id: string }>(
      'SELECT id FROM results WHERE sport = ? AND date = ? AND home_id = ? AND away_id = ? AND id <> ? ORDER BY created_at LIMIT 1',
    ),
    moveReports: db.prepare(
      `INSERT OR IGNORE INTO result_reports (result_id, user_id, home_score, away_score, periods, reported_at, source_id)
       SELECT ?, user_id, home_score, away_score, periods, reported_at, source_id FROM result_reports WHERE result_id = ?`,
    ),
    deleteResult: db.prepare('DELETE FROM results WHERE id = ?'),

    insertTemplate: db.prepare(
      'INSERT INTO templates (id, sport, name, layout, created_by, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    templateBySource: db.prepare<[string, string], { id: string }>('SELECT id FROM templates WHERE created_by = ? AND source_id = ?'),
    updateTemplate: db.prepare('UPDATE templates SET sport = ?, name = ?, layout = ?, updated_at = ? WHERE id = ?'),
    template: db.prepare<[string], TemplateRow>(
      'SELECT id, sport, name, layout, created_at, updated_at FROM templates WHERE id = ?',
    ),
    useTemplate: db.prepare(
      `INSERT INTO team_templates (team_id, template_id, user_id, used_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, template_id, user_id) DO UPDATE SET used_at = excluded.used_at`,
    ),
    teamTemplates: db.prepare<[string], { id: string; name: string; sport: string; users: number; last_used: number }>(
      `SELECT t.id, t.name, t.sport, COUNT(DISTINCT tt.user_id) AS users, MAX(tt.used_at) AS last_used
       FROM team_templates tt JOIN templates t ON t.id = tt.template_id
       WHERE tt.team_id = ? GROUP BY t.id ORDER BY users DESC, last_used DESC LIMIT 10`,
    ),

    insertResult: db.prepare('INSERT INTO results (id, sport, season, date, home_id, away_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    report: db.prepare(
      `INSERT INTO result_reports (result_id, user_id, home_score, away_score, periods, reported_at, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (result_id, user_id) DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score,
         periods = excluded.periods, reported_at = excluded.reported_at, source_id = excluded.source_id`,
    ),
    reports: db.prepare<[string], ReportRow>(
      'SELECT user_id, home_score, away_score, reported_at, source_id FROM result_reports WHERE result_id = ? ORDER BY reported_at, rowid',
    ),
    resultRow: db.prepare<[string], ResultRow>(
      'SELECT id, sport, season, date, home_id, away_id, created_at FROM results WHERE id = ?',
    ),
    /** Games between these two teams, either way round, in a date range. */
    pairResults: db.prepare<[string, string, string, string, string, string, string], ResultRow>(
      `SELECT id, sport, season, date, home_id, away_id, created_at FROM results
       WHERE sport = ? AND ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?)) AND date BETWEEN ? AND ?
       ORDER BY created_at`,
    ),
    mineBySource: db.prepare<[string, string], { result_id: string }>(
      'SELECT result_id FROM result_reports WHERE user_id = ? AND source_id = ?',
    ),
    teamResults: db.prepare<[string, string, string], { id: string }>(
      'SELECT id FROM results WHERE (home_id = ? OR away_id = ?) AND season = ? ORDER BY date DESC',
    ),
    seasonResults: db.prepare<[string, string], { id: string }>(
      'SELECT id FROM results WHERE sport = ? AND season = ? ORDER BY date DESC, created_at DESC LIMIT 5000',
    ),
    seasons: db.prepare<[string], { season: string; n: number }>(
      // Games with both sides reported: what the public scoreboard lists (partial games stay off it).
      `SELECT season, COUNT(*) AS n FROM results r WHERE sport = ?
         AND EXISTS (SELECT 1 FROM result_reports WHERE result_id = r.id AND home_score IS NOT NULL)
         AND EXISTS (SELECT 1 FROM result_reports WHERE result_id = r.id AND away_score IS NOT NULL)
       GROUP BY season ORDER BY season DESC`,
    ),
    retract: db.prepare('DELETE FROM result_reports WHERE result_id = ? AND user_id = ?'),
    orphanResults: db.prepare('DELETE FROM results WHERE id = ? AND NOT EXISTS (SELECT 1 FROM result_reports WHERE result_id = ?)'),

    addGroupTeam: db.prepare('INSERT OR IGNORE INTO group_teams (group_id, team_id, added_by) VALUES (?, ?, ?)'),
    removeGroupTeam: db.prepare('DELETE FROM group_teams WHERE group_id = ? AND team_id = ?'),
    groupTeams: db.prepare<[string], { team_id: string }>('SELECT team_id FROM group_teams WHERE group_id = ?'),
    groupResults: db.prepare<[string, string, string], { id: string }>(
      `SELECT r.id FROM results r
       WHERE r.season = ? AND r.home_id IN (SELECT team_id FROM group_teams WHERE group_id = ?)
         AND r.away_id IN (SELECT team_id FROM group_teams WHERE group_id = ?) ORDER BY r.date`,
    ),
    roster: db.prepare<[string, string, string], { players: string; updated_at: number }>(
      'SELECT players, updated_at FROM rosters WHERE group_id = ? AND team_id = ? AND season = ?',
    ),
    putRoster: db.prepare(
      `INSERT INTO rosters (group_id, team_id, season, players, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id, team_id, season) DO UPDATE SET players = excluded.players,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ),

    nextSeq: db.prepare<[], { value: number }>("UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value"),
    groupTemplate: db.prepare<[string, string], GroupTemplateRow>(
      `SELECT gt.*, u.display_name AS sharer_name, t.layout, t.created_at, t.updated_at AS template_updated_at
       FROM group_templates gt JOIN templates t ON t.id = gt.template_id LEFT JOIN users u ON u.id = gt.shared_by
       WHERE gt.group_id = ? AND gt.template_id = ?`,
    ),
    groupTemplatesSince: db.prepare<[string, number, number], GroupTemplateRow>(
      `SELECT gt.*, u.display_name AS sharer_name, t.layout, t.created_at, t.updated_at AS template_updated_at
       FROM group_templates gt JOIN templates t ON t.id = gt.template_id LEFT JOIN users u ON u.id = gt.shared_by
       WHERE gt.group_id = ? AND gt.seq > ? ORDER BY gt.seq LIMIT ?`,
    ),
    groupTemplateCount: db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM group_templates WHERE group_id = ? AND deleted = 0'),
    shareTemplate: db.prepare(
      `INSERT INTO group_templates (group_id, template_id, shared_by, shared_at, updated_at, deleted, seq) VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (group_id, template_id) DO UPDATE SET shared_by = excluded.shared_by, shared_at = excluded.shared_at,
         updated_at = excluded.updated_at, deleted = 0, seq = excluded.seq`,
    ),
    touchGroupTemplate: db.prepare('UPDATE group_templates SET updated_at = ?, seq = ? WHERE group_id = ? AND template_id = ?'),
    /** One seq for every group: a template appears once per group, so each group's feed still orders cleanly. */
    touchTemplateShares: db.prepare('UPDATE group_templates SET updated_at = ?, seq = ? WHERE template_id = ? AND deleted = 0'),
    unshareTemplate: db.prepare('UPDATE group_templates SET deleted = 1, updated_at = ?, seq = ? WHERE group_id = ? AND template_id = ?'),
    browseTemplates: db.prepare<[string, string, number], { id: string; name: string; sport: string; users: number; teams: number; groups: number; last_used: number }>(
      `WITH uses (template_id, user_id) AS (
         SELECT template_id, user_id FROM team_templates
         UNION SELECT template_id, shared_by FROM group_templates WHERE deleted = 0 AND shared_by IS NOT NULL
         UNION SELECT id, created_by FROM templates WHERE created_by IS NOT NULL
       )
       SELECT t.id, t.name, t.sport,
         (SELECT COUNT(DISTINCT user_id) FROM uses WHERE uses.template_id = t.id) AS users,
         (SELECT COUNT(DISTINCT team_id) FROM team_templates WHERE template_id = t.id) AS teams,
         (SELECT COUNT(*) FROM group_templates WHERE template_id = t.id AND deleted = 0) AS groups,
         MAX(t.updated_at,
             COALESCE((SELECT MAX(used_at) FROM team_templates WHERE template_id = t.id), 0),
             COALESCE((SELECT MAX(shared_at) FROM group_templates WHERE template_id = t.id AND deleted = 0), 0)) AS last_used
       FROM templates t
       WHERE t.sport = ? AND t.name LIKE ? ESCAPE '\\'
       ORDER BY users DESC, teams DESC, last_used DESC
       LIMIT ?`,
    ),
  };

  /** Follows merges to the team that lives on. */
  function live(id: string): TeamRow {
    let row = q.team.get(id);
    for (let hop = 0; row?.merged_into && hop < 16; hop++) row = q.team.get(row.merged_into);
    if (!row) throw ApiError.notFound('Team');
    return row;
  }

  const toTeam = (r: TeamRow): Team => ({
    id: r.id,
    sport: r.sport,
    name: r.name,
    school: r.school,
    town: r.town,
    state: r.state,
    level: r.level,
    gender: r.gender,
    aliases: q.aliases.all(r.id).map((a) => a.alias),
  });

  /** Each side as its reports have it: unknown, agreed, or conflicting. */
  function sidesOf(id: string) {
    const reports = q.reports.all(id);
    return {
      reports,
      home: combineSide(reports.map((x) => x.home_score)),
      away: combineSide(reports.map((x) => x.away_score)),
    };
  }

  function resultOf(id: string): Result | null {
    const r = q.resultRow.get(id);
    if (!r) return null;
    const { reports, home, away } = sidesOf(id);
    if (!reports.length) return null;
    const sides = [home, away];
    // Each user has one report per game, so a side's report count is its distinct scorekeepers.
    const status: ResultStatus = sides.some((x) => x.state === 'conflicting')
      ? 'disputed'
      : sides.some((x) => x.state === 'unknown')
        ? 'partial'
        : sides.some((x) => x.reports >= 2)
          ? 'confirmed'
          : 'reported';
    const side = (teamId: string, x: Side): ResultSide => {
      const t = live(teamId);
      return { id: t.id, name: t.name, score: x.score, state: x.state, reports: x.reports };
    };
    return {
      id: r.id,
      sport: r.sport,
      season: r.season,
      date: r.date,
      home: side(r.home_id, home),
      away: side(r.away_id, away),
      status,
      reports: reports.length,
    };
  }

  /**
   * The game another scorekeeper already reported that this report belongs to, if any:
   * the same two teams (either way round) within a day, where this scorekeeper has no
   * report yet. Closest date first, then the same home team, then one whose known scores
   * agree with this report. A game on another date is taken only if nothing conflicts; on
   * the same date a conflict still joins (and makes it disputed) when nothing fits better.
   */
  function findGame(
    nearby: ResultRow[],
    day: number,
    homeId: string,
    homeScore: number | null,
    awayScore: number | null,
    open: (g: ResultRow) => boolean,
  ): ResultRow | undefined {
    return nearby
      .filter(open)
      .map((g) => {
        const same = g.home_id === homeId;
        const [h, a] = same ? [homeScore, awayScore] : [awayScore, homeScore];
        const { home, away } = sidesOf(g.id);
        const clash = (v: number | null, x: Side) => v !== null && x.state !== 'unknown' && !x.values.has(v);
        return { g, gap: Math.abs(dayNumber(g.date) - day), same, conflict: clash(h, home) || clash(a, away) };
      })
      .filter((c) => c.gap === 0 || !c.conflict)
      .sort((x, y) => x.gap - y.gap || Number(y.same) - Number(x.same) || Number(x.conflict) - Number(y.conflict))[0]?.g;
  }

  const toGroupChange = (r: GroupTemplateRow, userId: string): GroupTemplateChange => {
    const deleted = r.deleted === 1;
    return {
      id: r.template_id,
      deleted,
      updatedAt: r.updated_at,
      seq: r.seq,
      data: deleted ? null : asDownloaded({ id: r.template_id, layout: r.layout, created_at: r.created_at, updated_at: r.template_updated_at }),
      sharedBy: deleted ? null : { userId: r.shared_by, name: r.sharer_name },
      sharedAt: deleted ? null : r.shared_at,
      mine: r.shared_by !== null && r.shared_by === userId,
    };
  };

  const api = {
    get: (id: string) => toTeam(live(id)),

    /** Finds the team this describes, or adds it. `similar` lists near-misses to offer a merge. */
    upsertTeam: db.transaction((input: TeamInput, userId: string): { team: Team; created: boolean; similar: Team[] } => {
      const key = dedupeKey(input);
      const existing = q.byKey.get(key);
      if (existing) return { team: toTeam(live(existing.id)), created: false, similar: [] };
      const id = randomUUID();
      const norm = normalizeName(input.name);
      q.insertTeam.run({
        id,
        sport: input.sport,
        name: input.name.trim(),
        norm,
        school: input.school?.trim() || null,
        town: input.town?.trim() || null,
        state: input.state?.trim().toUpperCase() || null,
        level: input.level,
        gender: input.gender,
        key,
        by: userId,
        at: now(),
      });
      const similar = q
        .similar.all(input.sport, input.level, input.gender)
        .filter((t) => t.id !== id && editDistance(t.norm, norm) <= Math.max(1, Math.floor(norm.length / 5)))
        .slice(0, 5)
        .map(toTeam);
      return { team: toTeam(q.team.get(id)!), created: true, similar };
    }),

    /** Ranked by closeness to what was typed; aliases count as names. */
    search(sport: string, text: string, filters: { level?: string; gender?: string; state?: string } = {}): Team[] {
      const norm = normalizeName(text);
      if (norm.length < 2) return [];
      const like = `%${norm}%`;
      const rows = q.search.all(sport, like, like, `%${text.trim()}%`);
      const score = (t: TeamRow) => {
        const names = [t.norm, ...q.aliases.all(t.id).map((a) => normalizeName(a.alias))];
        return Math.min(...names.map((n) => (n.startsWith(norm) ? 0 : editDistance(n, norm))));
      };
      return rows
        .filter((t) => (!filters.level || t.level === filters.level) && (!filters.gender || t.gender === filters.gender))
        .filter((t) => !filters.state || t.state === filters.state.toUpperCase())
        .map((t) => ({ t, s: score(t) }))
        .sort((a, b) => a.s - b.s || a.t.name.localeCompare(b.t.name))
        .slice(0, 20)
        .map((x) => toTeam(x.t));
    },

    addAlias(teamId: string, alias: string) {
      const t = live(teamId);
      const norm = normalizeName(alias);
      if (!norm || norm === t.norm) return toTeam(t);
      q.addAlias.run(t.id, norm, alias.trim().slice(0, 80));
      return toTeam(t);
    },

    /**
     * One scorekeeper's vote that two teams are the same. When MERGE_VOTES different
     * people agree, `from` folds into `into`: aliases, templates, groups and results move.
     */
    voteMerge: db.transaction((fromId: string, intoId: string, userId: string) => {
      const from = live(fromId);
      const into = live(intoId);
      if (from.id === into.id) return { merged: true, into: toTeam(into), votes: MERGE_VOTES };
      if (from.sport !== into.sport) throw ApiError.badRequest('DifferentSport', 'Those teams play different sports.');
      q.vote.run(from.id, into.id, userId, now());
      const votes = q.votes.get(from.id, into.id)!.n;
      if (votes < MERGE_VOTES) return { merged: false, into: toTeam(into), votes };

      q.addAlias.run(into.id, from.norm, from.name);
      q.moveAliases.run(into.id, from.id);
      q.moveTemplates.run(into.id, from.id);
      q.moveGroupTeams.run(into.id, from.id);
      for (const r of q.resultsOf.all(from.id, from.id)) {
        const home = r.home_id === from.id ? into.id : r.home_id;
        const away = r.away_id === from.id ? into.id : r.away_id;
        const clash = q.resultBy.get(r.sport, r.date, home, away, r.id);
        if (clash && clash.id !== r.id) {
          // The same game reported under both names: one result, all its reports.
          q.moveReports.run(clash.id, r.id);
          q.deleteResult.run(r.id);
        } else {
          q.setSides.run(home, away, r.id);
        }
      }
      q.markMerged.run(into.id, now(), from.id);
      return { merged: true, into: toTeam(into), votes };
    }),

    /**
     * A layout only: never a photo, and anchors only as printed scoresheet words. Callers
     * pass sanitizeLayout's output. With the app's own template id (`sourceId`), the same
     * scorekeeper publishing it again updates their template, and every group it is
     * shared with sees the change on its next pull.
     */
    publishTemplate: db.transaction((layout: SharedLayout, userId: string, sourceId: string | null = null) => {
      const at = now();
      const name = layout.name.trim().slice(0, 80);
      const existing = sourceId ? q.templateBySource.get(userId, sourceId) : undefined;
      if (existing) {
        q.updateTemplate.run(layout.sport, name, JSON.stringify(layout), at, existing.id);
        q.touchTemplateShares.run(at, q.nextSeq.get()!.value, existing.id);
        return { id: existing.id, sport: layout.sport, name, created: false };
      }
      const id = randomUUID();
      q.insertTemplate.run(id, layout.sport, name, JSON.stringify(layout), userId, sourceId, at, at);
      return { id, sport: layout.sport, name, created: true };
    }),

    template(id: string) {
      const t = q.template.get(id);
      if (!t) throw ApiError.notFound('Template');
      return { id: t.id, sport: t.sport, name: t.name, layout: JSON.parse(t.layout) as unknown, createdAt: t.created_at, updatedAt: t.updated_at };
    },

    /**
     * Widely used templates for a sport, most scorekeepers first: candidates for built-in
     * books. Counts only: no scorekeeper, team or group is named.
     */
    browseTemplates(sport: string, text = '', limit = 50) {
      const like = `%${text.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      return q.browseTemplates.all(sport, like, Math.min(MAX_BROWSE, Math.max(1, limit))).map((t) => ({
        id: t.id, name: t.name, sport: t.sport, users: t.users, teams: t.teams, groups: t.groups, lastUsed: t.last_used,
      }));
    },

    /** Records that this scorekeeper read this team's book with this template. */
    useTemplate(teamId: string, templateId: string, userId: string) {
      const t = live(teamId);
      api.template(templateId);
      q.useTemplate.run(t.id, templateId, userId, now());
    },

    templatesFor: (teamId: string) => q.teamTemplates.all(live(teamId).id).map((t) => ({
      id: t.id, name: t.name, sport: t.sport, scorekeepers: t.users, lastUsed: t.last_used,
    })),

    /**
     * One scorekeeper's final score, often only their own team's. It joins the game other
     * scorekeepers already reported when there is one (see findGame), mapped onto that
     * game's home and away; otherwise it starts a new game.
     */
    report: db.transaction((input: ResultInput, userId: string): Result => {
      const home = live(input.homeId);
      const away = live(input.awayId);
      if (home.id === away.id) throw ApiError.badRequest('SameTeam', 'A team cannot play itself.');
      if (home.sport !== input.sport || away.sport !== input.sport) {
        throw ApiError.badRequest('DifferentSport', 'Both teams must play this sport.');
      }
      const homeScore = input.homeScore ?? null;
      const awayScore = input.awayScore ?? null;
      if (homeScore === null && awayScore === null) throw ApiError.badRequest('NoScore', "Report at least one team's score.");
      const sourceId = input.sourceId ?? null;
      const at = now();

      const day = dayNumber(input.date);
      const nearby = q.pairResults.all(input.sport, home.id, away.id, away.id, home.id, isoDay(day - 1), isoDay(day + 1));
      const reportOf = (gameId: string) => q.reports.all(gameId).find((x) => x.user_id === userId);

      // This scanned game reported before, against other teams or more than a day off: that report goes.
      const earlier = sourceId ? q.mineBySource.get(userId, sourceId) : undefined;
      if (earlier && !nearby.some((g) => g.id === earlier.result_id)) {
        q.retract.run(earlier.result_id, userId);
        q.orphanResults.run(earlier.result_id, earlier.result_id);
      }

      const same = (g: ResultRow) => g.home_id === home.id;
      // A re-report replaces the scorekeeper's own report: the one for the same scanned game,
      // or (without ids to tell games apart) theirs for these teams on the same date.
      const mine = nearby
        .map((g) => ({ g, own: reportOf(g.id) }))
        .filter((x) => x.own)
        .filter(({ g, own }) =>
          earlier ? g.id === earlier.result_id : g.date === input.date && !(sourceId && own!.source_id && own!.source_id !== sourceId),
        )
        .sort((x, y) => Number(same(y.g)) - Number(same(x.g)))[0]?.g;

      const target = mine ?? findGame(nearby, day, home.id, homeScore, awayScore, (g) => !reportOf(g.id));
      let gameId: string;
      let flipped = false;
      if (target) {
        gameId = target.id;
        flipped = !same(target);
      } else {
        gameId = randomUUID();
        q.insertResult.run(gameId, input.sport, seasonFor(input.date), input.date, home.id, away.id, at);
      }
      const [h, a] = flipped ? [awayScore, homeScore] : [homeScore, awayScore];
      const p = input.periods;
      const periods = p && (p.home || p.away)
        ? JSON.stringify(flipped ? { home: p.away ?? null, away: p.home ?? null } : { home: p.home ?? null, away: p.away ?? null })
        : null;
      q.report.run(gameId, userId, h, a, periods, at, sourceId);
      return resultOf(gameId)!;
    }),

    retract: db.transaction((resultId: string, userId: string) => {
      q.retract.run(resultId, userId);
      q.orphanResults.run(resultId, resultId);
    }),

    result: (id: string) => resultOf(id),

    teamResults(teamId: string, season: string): Result[] {
      const t = live(teamId);
      return q.teamResults.all(t.id, t.id, season).map((r) => resultOf(r.id)).filter((r): r is Result => r !== null);
    },

    /**
     * Wins and losses from results with both scores known, counting reported and confirmed;
     * disputed are listed apart and partial (a side nobody reported yet) are left out.
     */
    standings(teamIds: string[], results: Result[]) {
      const table = new Map(teamIds.map((id) => [id, { team: api.get(id), w: 0, l: 0, pf: 0, pa: 0, disputed: 0 }]));
      for (const r of results) {
        const h = table.get(r.home.id);
        const a = table.get(r.away.id);
        if (r.status === 'disputed') {
          if (h) h.disputed++;
          if (a) a.disputed++;
          continue;
        }
        if (!isFinal(r) || r.home.score === null || r.away.score === null) continue;
        if (h) {
          h.pf += r.home.score;
          h.pa += r.away.score;
          if (r.home.score > r.away.score) h.w++;
          else if (r.home.score < r.away.score) h.l++;
        }
        if (a) {
          a.pf += r.away.score;
          a.pa += r.home.score;
          if (r.away.score > r.home.score) a.w++;
          else if (r.away.score < r.home.score) a.l++;
        }
      }
      return [...table.values()].sort((x, y) => y.w - x.w || x.l - y.l || (y.pf - y.pa) - (x.pf - x.pa));
    },

    // --- the public scoreboard (inkstat.app) ---

    /**
     * A season's scores for anyone to read: team names, places, dates and final scores.
     * Nothing from a group, no rosters, no scorekeepers, no report counts. A disputed
     * result shows no score, since nobody can say which one is right. A partial game (only
     * one team's score reported so far) is left off until the other side is reported: half a
     * final isn't a result, and the scoreboard's readers can't tell it from a score of null.
     */
    publicSeason(sport: string, season: string) {
      const results = q.seasonResults.all(sport, season).map((r) => resultOf(r.id))
        // Both sides reported (as publicSeasons counts): no partial game, nor a disputed one missing a side.
        .filter((r): r is Result & { status: PublicResult['status'] } =>
          r !== null && r.status !== 'partial' && r.home.state !== 'unknown' && r.away.state !== 'unknown');
      const teams = new Map<string, PublicTeam>();
      const side = (s: Result['home'], disputed: boolean) => {
        if (!teams.has(s.id)) {
          const t = live(s.id);
          teams.set(t.id, { id: t.id, name: t.name, town: t.town, state: t.state, level: t.level, gender: t.gender });
        }
        return { id: s.id, score: disputed ? null : s.score };
      };
      const games: PublicResult[] = results.map((r) => ({
        id: r.id,
        date: r.date,
        home: side(r.home, r.status === 'disputed'),
        away: side(r.away, r.status === 'disputed'),
        status: r.status,
      }));
      return { teams: [...teams.values()], results: games };
    },

    publicSeasons: (sport: string) => q.seasons.all(sport).map((s) => ({ season: s.season, games: s.n })),

    // --- inside a group ---

    addGroupTeam: (groupId: string, teamId: string, userId: string) => q.addGroupTeam.run(groupId, live(teamId).id, userId),
    removeGroupTeam: (groupId: string, teamId: string) => q.removeGroupTeam.run(groupId, teamId),
    groupTeams: (groupId: string) => q.groupTeams.all(groupId).map((r) => api.get(r.team_id)),
    groupResults: (groupId: string, season: string) =>
      q.groupResults.all(season, groupId, groupId).map((r) => resultOf(r.id)).filter((r): r is Result => r !== null),

    /** Player names never leave the group they were shared with. */
    roster(groupId: string, teamId: string, season: string): { players: RosterPlayer[]; updatedAt: number | null } {
      const r = q.roster.get(groupId, live(teamId).id, season);
      return r ? { players: JSON.parse(r.players) as RosterPlayer[], updatedAt: r.updated_at } : { players: [], updatedAt: null };
    },
    putRoster(groupId: string, teamId: string, season: string, players: RosterPlayer[], userId: string) {
      q.putRoster.run(groupId, live(teamId).id, season, JSON.stringify(players), userId, now());
    },

    // Shared templates: callers have already checked membership (groups.require).

    /** Shares a registry template with a group; sharing it again tells members it changed. */
    shareTemplate: db.transaction((groupId: string, templateId: string, userId: string): { change: GroupTemplateChange; created: boolean } => {
      api.template(templateId);
      const at = now();
      const seq = q.nextSeq.get()!.value;
      const existing = q.groupTemplate.get(groupId, templateId);
      if (existing && !existing.deleted) {
        // Already there: keep who shared it first.
        q.touchGroupTemplate.run(at, seq, groupId, templateId);
      } else {
        if (q.groupTemplateCount.get(groupId)!.n >= MAX_GROUP_TEMPLATES) {
          throw ApiError.forbidden('TooManyTemplates', `A group can share up to ${MAX_GROUP_TEMPLATES} templates.`);
        }
        q.shareTemplate.run(groupId, templateId, userId, at, at, seq);
      }
      return { change: api.groupTemplate(groupId, templateId, userId)!, created: !existing || existing.deleted === 1 };
    }),

    /** Publishes (or updates) a sanitized layout and shares it with the group, all or nothing. */
    publishToGroup: db.transaction((groupId: string, layout: SharedLayout, userId: string, sourceId: string | null) =>
      api.shareTemplate(groupId, api.publishTemplate(layout, userId, sourceId).id, userId),
    ),

    /** Owners and whoever shared it may take it back; members' feeds get a tombstone. */
    unshareTemplate: db.transaction((groupId: string, templateId: string, userId: string, role: 'owner' | 'member') => {
      const row = q.groupTemplate.get(groupId, templateId);
      if (!row || row.deleted) throw ApiError.notFound('Template');
      if (role !== 'owner' && row.shared_by !== userId) {
        throw ApiError.forbidden('NotYours', 'Only the person who shared it or a group owner can remove it.');
      }
      q.unshareTemplate.run(now(), q.nextSeq.get()!.value, groupId, templateId);
    }),

    groupTemplate(groupId: string, templateId: string, userId: string): GroupTemplateChange | null {
      const r = q.groupTemplate.get(groupId, templateId);
      return r ? toGroupChange(r, userId) : null;
    },

    groupTemplateChanges: (groupId: string, since: number, limit: number, userId: string) =>
      q.groupTemplatesSince.all(groupId, since, limit).map((r) => toGroupChange(r, userId)),
  };
  return api;
}

export type Registry = ReturnType<typeof createRegistry>;
