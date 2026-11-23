import Database from 'better-sqlite3';

import type { Game } from '@inkstat/basketball';

export type DB = Database.Database;

/** Append-only list; each entry runs once, in order, tracked by PRAGMA user_version. */
const MIGRATIONS = [
  `
  CREATE TABLE games (
    space      TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    season     TEXT    NOT NULL,
    date       TEXT,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    seq        INTEGER NOT NULL,
    data       TEXT,
    PRIMARY KEY (space, id)
  );
  CREATE INDEX games_by_seq ON games (space, seq);
  CREATE INDEX games_by_season ON games (space, season, deleted);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO meta (key, value) VALUES ('seq', 0);
  `,
  // 2: accounts (Apple/Google sign-in, Orbit's session model), groups, and the shared registry.
  `
  CREATE TABLE users (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE,
    email_verified_at INTEGER,
    display_name      TEXT NOT NULL,
    created_at        INTEGER NOT NULL
  );
  CREATE TABLE user_logins (
    provider          TEXT NOT NULL,
    subject           TEXT NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    apple_refresh     TEXT,
    created_at        INTEGER NOT NULL,
    last_used_at      INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX user_logins_by_user ON user_logins (user_id);
  CREATE TABLE refresh_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER,
    replaced_by TEXT
  );
  CREATE INDEX refresh_tokens_by_user ON refresh_tokens (user_id);

  CREATE TABLE groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE members (
    group_id  TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role      TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX members_by_user ON members (user_id);

  CREATE TABLE teams (
    id          TEXT PRIMARY KEY,
    sport       TEXT NOT NULL,
    name        TEXT NOT NULL,
    norm        TEXT NOT NULL,
    school      TEXT,
    town        TEXT,
    state       TEXT,
    level       TEXT NOT NULL,
    gender      TEXT NOT NULL,
    dedupe_key  TEXT NOT NULL UNIQUE,
    merged_into TEXT,
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX teams_by_norm ON teams (sport, norm);
  CREATE TABLE team_aliases (
    team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    alias_norm TEXT NOT NULL,
    alias      TEXT NOT NULL,
    PRIMARY KEY (team_id, alias_norm)
  );
  CREATE INDEX team_aliases_by_norm ON team_aliases (alias_norm);
  CREATE TABLE merge_votes (
    from_id    TEXT NOT NULL,
    into_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, into_id, user_id)
  );

  CREATE TABLE templates (
    id         TEXT PRIMARY KEY,
    sport      TEXT NOT NULL,
    name       TEXT NOT NULL,
    layout     TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE team_templates (
    team_id     TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    used_at     INTEGER NOT NULL,
    PRIMARY KEY (team_id, template_id, user_id)
  );

  CREATE TABLE results (
    id         TEXT PRIMARY KEY,
    sport      TEXT NOT NULL,
    season     TEXT NOT NULL,
    date       TEXT NOT NULL,
    home_id    TEXT NOT NULL REFERENCES teams (id),
    away_id    TEXT NOT NULL REFERENCES teams (id),
    created_at INTEGER NOT NULL,
    UNIQUE (sport, date, home_id, away_id)
  );
  CREATE INDEX results_by_home ON results (home_id, season);
  CREATE INDEX results_by_away ON results (away_id, season);
  CREATE TABLE result_reports (
    result_id   TEXT NOT NULL REFERENCES results (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    home_score  INTEGER NOT NULL,
    away_score  INTEGER NOT NULL,
    periods     TEXT,
    reported_at INTEGER NOT NULL,
    PRIMARY KEY (result_id, user_id)
  );

  CREATE TABLE group_teams (
    group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    team_id  TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    added_by TEXT,
    PRIMARY KEY (group_id, team_id)
  );
  CREATE TABLE rosters (
    group_id   TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    season     TEXT NOT NULL,
    players    TEXT NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, team_id, season)
  );
  `,
  // 3: other synced records (templates now), per space and collection, on the same seq as games.
  `
  CREATE TABLE docs (
    space      TEXT    NOT NULL,
    collection TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    seq        INTEGER NOT NULL,
    data       TEXT,
    PRIMARY KEY (space, collection, id)
  );
  CREATE INDEX docs_by_seq ON docs (space, collection, seq);
  `,
  // 4: the public scoreboard reads a whole season at once.
  `
  CREATE INDEX results_by_season ON results (sport, season, date);
  `,
  // 5: templates shared into groups (a change feed on the same seq), re-publish by the app's id, browsing.
  `
  ALTER TABLE templates ADD COLUMN source_id TEXT;
  ALTER TABLE templates ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  UPDATE templates SET updated_at = created_at;
  CREATE UNIQUE INDEX templates_by_source ON templates (created_by, source_id) WHERE source_id IS NOT NULL;
  CREATE INDEX templates_by_sport ON templates (sport, name);
  CREATE INDEX team_templates_by_template ON team_templates (template_id);
  CREATE TABLE group_templates (
    group_id    TEXT    NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    template_id TEXT    NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    shared_by   TEXT    REFERENCES users (id) ON DELETE SET NULL,
    shared_at   INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (group_id, template_id)
  );
  CREATE INDEX group_templates_by_seq ON group_templates (group_id, seq);
  CREATE INDEX group_templates_by_template ON group_templates (template_id);
  `,
  // 6: one-sided reports (each scorekeeper may know only their own team's score), reports
  // matched across scorekeepers by the unordered pair of teams and a date within a day, so
  // the old one-result-per-(sport, date, home, away) rule goes: a doubleheader is two games.
  // Tables are rebuilt (SQLite can't drop a constraint). The new reports table points at
  // results_new; renaming results_new to results rewrites that reference. The old reports
  // table goes first, so dropping the old results cascades into nothing.
  `
  CREATE TABLE results_new (
    id         TEXT PRIMARY KEY,
    sport      TEXT NOT NULL,
    season     TEXT NOT NULL,
    date       TEXT NOT NULL,
    home_id    TEXT NOT NULL REFERENCES teams (id),
    away_id    TEXT NOT NULL REFERENCES teams (id),
    created_at INTEGER NOT NULL
  );
  INSERT INTO results_new (id, sport, season, date, home_id, away_id, created_at)
    SELECT id, sport, season, date, home_id, away_id, created_at FROM results;
  CREATE TABLE result_reports_new (
    result_id   TEXT NOT NULL REFERENCES results_new (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    home_score  INTEGER,
    away_score  INTEGER,
    periods     TEXT,
    reported_at INTEGER NOT NULL,
    source_id   TEXT,
    PRIMARY KEY (result_id, user_id),
    CHECK (home_score IS NOT NULL OR away_score IS NOT NULL)
  );
  INSERT INTO result_reports_new (result_id, user_id, home_score, away_score, periods, reported_at)
    SELECT result_id, user_id, home_score, away_score, periods, reported_at FROM result_reports;
  DROP TABLE result_reports;
  DROP TABLE results;
  ALTER TABLE results_new RENAME TO results;
  ALTER TABLE result_reports_new RENAME TO result_reports;
  CREATE INDEX results_by_home ON results (home_id, season);
  CREATE INDEX results_by_away ON results (away_id, season);
  CREATE INDEX results_by_season ON results (sport, season, date);
  CREATE INDEX results_by_pair ON results (sport, home_id, away_id, date);
  CREATE INDEX result_reports_by_source ON result_reports (user_id, source_id) WHERE source_id IS NOT NULL;
  `,
];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}

interface Row {
  id: string;
  updated_at: number;
  deleted: number;
  seq: number;
  data: string | null;
}

export interface Change {
  id: string;
  deleted: boolean;
  updatedAt: number;
  seq: number;
  game: Game | null;
}

export type PutResult =
  | { status: 'saved' | 'unchanged'; change: Change }
  | { status: 'conflict'; current: Change };

const toChange = (r: Row): Change => ({
  id: r.id,
  deleted: r.deleted === 1,
  updatedAt: r.updated_at,
  seq: r.seq,
  game: r.data ? (JSON.parse(r.data) as Game) : null,
});

/**
 * Games are stored per "space" (one per API key, e.g. a team). Every write
 * takes the next value of a global sequence, so clients can ask for
 * "everything since seq N" without trusting device clocks for ordering.
 * Conflicts resolve last-writer-wins on the client's updatedAt.
 */
export function createStore(db: DB) {
  const getRow = db.prepare<[string, string], Row>(
    'SELECT id, updated_at, deleted, seq, data FROM games WHERE space = ? AND id = ?',
  );
  const nextSeq = db.prepare<[], { value: number }>(
    "UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value",
  );
  const upsert = db.prepare(
    `INSERT INTO games (space, id, season, date, updated_at, deleted, seq, data)
     VALUES (@space, @id, @season, @date, @updatedAt, @deleted, @seq, @data)
     ON CONFLICT (space, id) DO UPDATE SET season = excluded.season, date = excluded.date,
       updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq, data = excluded.data`,
  );
  const changesSince = db.prepare<[string, number, number], Row>(
    'SELECT id, updated_at, deleted, seq, data FROM games WHERE space = ? AND seq > ? ORDER BY seq LIMIT ?',
  );
  const seasonRows = db.prepare<[string], { season: string; games: number }>(
    'SELECT season, COUNT(*) AS games FROM games WHERE space = ? AND deleted = 0 GROUP BY season ORDER BY season DESC',
  );
  const seasonGames = db.prepare<[string, string], { data: string }>(
    'SELECT data FROM games WHERE space = ? AND season = ? AND deleted = 0 ORDER BY date, updated_at',
  );

  return {
    get(space: string, id: string): Change | null {
      const row = getRow.get(space, id);
      return row ? toChange(row) : null;
    },

    put: db.transaction((space: string, game: Game): PutResult => {
      const existing = getRow.get(space, game.id);
      if (existing && existing.updated_at > game.updatedAt) {
        return { status: 'conflict', current: toChange(existing) };
      }
      if (existing && !existing.deleted && existing.updated_at === game.updatedAt) {
        return { status: 'unchanged', change: toChange(existing) };
      }
      const seq = nextSeq.get()!.value;
      upsert.run({
        space,
        id: game.id,
        season: game.season,
        date: game.date,
        updatedAt: game.updatedAt,
        deleted: 0,
        seq,
        data: JSON.stringify(game),
      });
      return { status: 'saved', change: { id: game.id, deleted: false, updatedAt: game.updatedAt, seq, game } };
    }),

    /** Deletes leave a tombstone so other devices learn about them on their next pull. */
    remove: db.transaction((space: string, id: string, deletedAt: number): PutResult => {
      const existing = getRow.get(space, id);
      if (existing && existing.updated_at > deletedAt) {
        return { status: 'conflict', current: toChange(existing) };
      }
      if (existing?.deleted) return { status: 'unchanged', change: toChange(existing) };
      const seq = nextSeq.get()!.value;
      upsert.run({ space, id, season: '', date: null, updatedAt: deletedAt, deleted: 1, seq, data: null });
      return { status: 'saved', change: { id, deleted: true, updatedAt: deletedAt, seq, game: null } };
    }),

    changes(space: string, since: number, limit: number): Change[] {
      return changesSince.all(space, since, limit).map(toChange);
    },

    seasons(space: string) {
      return seasonRows.all(space);
    },

    /** Everything in a space, gone: for a deleted account's personal space. */
    purge(space: string) {
      db.prepare('DELETE FROM games WHERE space = ?').run(space);
    },

    seasonGames(space: string, season: string): Game[] {
      return seasonGames.all(space, season).map((r) => JSON.parse(r.data) as Game);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export interface DocChange<T = unknown> {
  id: string;
  deleted: boolean;
  updatedAt: number;
  seq: number;
  data: T | null;
}

export type DocPutResult<T = unknown> =
  | { status: 'saved' | 'unchanged'; change: DocChange<T> }
  | { status: 'conflict'; current: DocChange<T> };

/**
 * Synced records other than games (templates for now), with the same rules as games:
 * a change feed by global seq, last-writer-wins on the client's updatedAt, tombstones.
 */
export function createDocs(db: DB) {
  const row = db.prepare<[string, string, string], { id: string; updated_at: number; deleted: number; seq: number; data: string | null }>(
    'SELECT id, updated_at, deleted, seq, data FROM docs WHERE space = ? AND collection = ? AND id = ?',
  );
  const nextSeq = db.prepare<[], { value: number }>("UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value");
  const upsert = db.prepare(
    `INSERT INTO docs (space, collection, id, updated_at, deleted, seq, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (space, collection, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted,
       seq = excluded.seq, data = excluded.data`,
  );
  const since = db.prepare<[string, string, number, number], { id: string; updated_at: number; deleted: number; seq: number; data: string | null }>(
    'SELECT id, updated_at, deleted, seq, data FROM docs WHERE space = ? AND collection = ? AND seq > ? ORDER BY seq LIMIT ?',
  );
  const toChange = (r: { id: string; updated_at: number; deleted: number; seq: number; data: string | null }): DocChange => ({
    id: r.id,
    deleted: r.deleted === 1,
    updatedAt: r.updated_at,
    seq: r.seq,
    data: r.data ? JSON.parse(r.data) : null,
  });

  return {
    get(space: string, collection: string, id: string): DocChange | null {
      const r = row.get(space, collection, id);
      return r ? toChange(r) : null;
    },
    put: db.transaction((space: string, collection: string, id: string, updatedAt: number, data: unknown): DocPutResult => {
      const existing = row.get(space, collection, id);
      if (existing && existing.updated_at > updatedAt) return { status: 'conflict', current: toChange(existing) };
      if (existing && !existing.deleted && existing.updated_at === updatedAt) return { status: 'unchanged', change: toChange(existing) };
      const seq = nextSeq.get()!.value;
      upsert.run(space, collection, id, updatedAt, 0, seq, JSON.stringify(data));
      return { status: 'saved', change: { id, deleted: false, updatedAt, seq, data } };
    }),
    remove: db.transaction((space: string, collection: string, id: string, deletedAt: number): DocPutResult => {
      const existing = row.get(space, collection, id);
      if (existing && existing.updated_at > deletedAt) return { status: 'conflict', current: toChange(existing) };
      if (existing?.deleted) return { status: 'unchanged', change: toChange(existing) };
      const seq = nextSeq.get()!.value;
      upsert.run(space, collection, id, deletedAt, 1, seq, null);
      return { status: 'saved', change: { id, deleted: true, updatedAt: deletedAt, seq, data: null } };
    }),
    purge(space: string) {
      db.prepare('DELETE FROM docs WHERE space = ?').run(space);
    },
    changes(space: string, collection: string, after: number, limit: number): DocChange[] {
      return since.all(space, collection, after, limit).map(toChange);
    },
  };
}

export type Docs = ReturnType<typeof createDocs>;
