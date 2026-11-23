import type { Game, ScorebookTemplate } from '@inkstat/basketball';
import type { SQLiteDatabase } from 'expo-sqlite';

import { ApiError, apiFetch, loadSession } from '@/auth/session';
import {
  clearTemplateTombstone,
  clearTombstone,
  deleteGameFromSync,
  deleteTemplateFromSync,
  gamesUpdatedSince,
  getGame,
  getSetting,
  getTemplate,
  listTemplates,
  listTemplateTombstones,
  listTombstones,
  saveGame,
  saveTemplate,
  setSetting,
} from '@/db';

/**
 * Sync with the InkStat API. The phone stays the source of truth while offline; a sync
 * pushes local changes, then pulls everything newer. Conflicts are last-writer-wins on
 * updatedAt, decided by the server.
 *
 * It syncs the signed-in account's own games and templates (`/v1/me/...`) on
 * api.inkstat.app, so they follow the scorekeeper to any device. There is no server
 * to configure.
 */

const KEYS = {
  lastSync: 'sync.lastSync',
  // Cursors and push marks are per destination, so switching never skips anything.
  cursor: (dest: string, what: string) => `sync.${dest}.${what}.cursor`,
  pushedAt: (dest: string, what: string) => `sync.${dest}.${what}.pushedAt`,
} as const;

export interface SyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: number;
}

interface Change<T> {
  id: string;
  deleted: boolean;
  updatedAt: number;
  seq: number;
  game?: T | null;
  data?: T | null;
}

class SyncError extends Error {}

export async function lastSyncedAt(db: SQLiteDatabase): Promise<number | null> {
  const v = await getSetting(db, KEYS.lastSync);
  return v ? Number(v) : null;
}

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

const accountSender: Send = async (method, path, body) => {
  try {
    return await apiFetch(`/v1/me${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new SyncError(e instanceof ApiError ? e.message : String(e));
  }
};

/** Keep this phone's photo paths when replacing a game with the server's copy. */
function mergeLocalFiles(incoming: Game, local: Game | null): Game {
  if (!local) return incoming;
  return {
    ...incoming,
    home: { ...incoming.home, pageUri: local.home.pageUri, crops: local.home.crops },
    away: { ...incoming.away, pageUri: local.away.pageUri, crops: local.away.crops },
  };
}

async function detail(res: Response): Promise<string> {
  const d = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
  return d.issues?.[0] ?? d.error ?? String(res.status);
}

export type Progress = (fraction: number, step: string) => void;

async function syncGames(db: SQLiteDatabase, send: Send, dest: string, result: SyncResult, progress: Progress) {
  progress(0.05, 'Sending games');
  const startedAt = Date.now();
  const pushedAt = Number((await getSetting(db, KEYS.pushedAt(dest, 'games'))) ?? 0);
  for (const game of await gamesUpdatedSince(db, pushedAt)) {
    const res = await send('PUT', `/games/${game.id}`, game);
    if (res.status === 409) {
      const { current } = (await res.json()) as { current: Change<Game> };
      result.conflicts++;
      if (current.deleted) await deleteGameFromSync(db, game.id);
      else if (current.game) await saveGame(db, mergeLocalFiles(current.game, game));
    } else if (!res.ok) {
      throw new SyncError(`Could not upload a game: ${await detail(res)}`);
    } else result.pushed++;
  }
  for (const t of await listTombstones(db)) {
    const res = await send('DELETE', `/games/${t.id}?deletedAt=${t.deletedAt}`);
    if (res.status === 409) {
      const { current } = (await res.json()) as { current: Change<Game> };
      result.conflicts++;
      if (current.game) await saveGame(db, current.game);
    } else if (!res.ok) throw new SyncError(`Could not send a delete: ${res.status}`);
    await clearTombstone(db, t.id);
  }
  await setSetting(db, KEYS.pushedAt(dest, 'games'), String(startedAt));
  progress(0.3, 'Getting games');

  let cursor = Number((await getSetting(db, KEYS.cursor(dest, 'games'))) ?? 0);
  for (;;) {
    const res = await send('GET', `/games?since=${cursor}`);
    if (!res.ok) throw new SyncError(`Could not download changes: ${res.status}`);
    const page = (await res.json()) as { changes: Change<Game>[]; cursor: number; more: boolean };
    for (const change of page.changes) {
      const local = await getGame(db, change.id);
      if (change.deleted) {
        if (local && local.updatedAt <= change.updatedAt) {
          await deleteGameFromSync(db, change.id);
          result.deleted++;
        }
      } else if (change.game && (!local || local.updatedAt < change.updatedAt)) {
        await saveGame(db, mergeLocalFiles(change.game, local));
        result.pulled++;
      }
    }
    cursor = page.cursor;
    await setSetting(db, KEYS.cursor(dest, 'games'), String(cursor));
    if (!page.more) break;
  }
}

async function syncTemplates(db: SQLiteDatabase, send: Send, dest: string, result: SyncResult, progress: Progress) {
  progress(0.6, 'Sending templates');
  const startedAt = Date.now();
  const pushedAt = Number((await getSetting(db, KEYS.pushedAt(dest, 'templates'))) ?? 0);
  // Templates on this phone keep their photo; the server never stores it.
  const keepPhoto = (incoming: ScorebookTemplate, local: ScorebookTemplate | null): ScorebookTemplate => ({
    ...incoming,
    photoUri: local?.photoUri ?? null,
  });
  for (const t of (await listTemplates(db)).filter((x) => x.updatedAt > pushedAt)) {
    const res = await send('PUT', `/templates/${encodeURIComponent(t.id)}`, t);
    if (res.status === 409) {
      const { current } = (await res.json()) as { current: Change<ScorebookTemplate> };
      result.conflicts++;
      if (current.deleted) await deleteTemplateFromSync(db, t.id);
      else if (current.data) await saveTemplate(db, keepPhoto(current.data, t));
    } else if (!res.ok) {
      throw new SyncError(`Could not upload a template: ${await detail(res)}`);
    } else result.pushed++;
  }
  for (const [id, deletedAt] of Object.entries(await listTemplateTombstones(db))) {
    const res = await send('DELETE', `/templates/${encodeURIComponent(id)}?deletedAt=${deletedAt}`);
    if (res.status === 409) {
      const { current } = (await res.json()) as { current: Change<ScorebookTemplate> };
      result.conflicts++;
      if (current.data) await saveTemplate(db, keepPhoto(current.data, null));
    } else if (!res.ok) throw new SyncError(`Could not send a template delete: ${res.status}`);
    await clearTemplateTombstone(db, id);
  }
  await setSetting(db, KEYS.pushedAt(dest, 'templates'), String(startedAt));
  progress(0.8, 'Getting templates');

  let cursor = Number((await getSetting(db, KEYS.cursor(dest, 'templates'))) ?? 0);
  for (;;) {
    const res = await send('GET', `/templates?since=${cursor}`);
    if (!res.ok) throw new SyncError(`Could not download templates: ${res.status}`);
    const page = (await res.json()) as { changes: Change<ScorebookTemplate>[]; cursor: number; more: boolean };
    for (const change of page.changes) {
      const local = await getTemplate(db, change.id);
      if (change.deleted) {
        if (local && local.updatedAt <= change.updatedAt) {
          await deleteTemplateFromSync(db, change.id);
          result.deleted++;
        }
      } else if (change.data && (!local || local.updatedAt < change.updatedAt)) {
        await saveTemplate(db, keepPhoto(change.data, local));
        result.pulled++;
      }
    }
    cursor = page.cursor;
    await setSetting(db, KEYS.cursor(dest, 'templates'), String(cursor));
    if (!page.more) break;
  }
}

let running: Promise<SyncResult> | null = null;

/** Push, then pull. One sync at a time; a second call joins the first. */
export function syncNow(db: SQLiteDatabase, progress: Progress = () => undefined): Promise<SyncResult> {
  running ??= (async () => {
    try {
      const session = await loadSession();
      if (!session) throw new SyncError('Sign in to sync.');
      const result: SyncResult = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0 };
      const dest = `u-${session.user.id}`;
      await syncGames(db, accountSender, dest, result, progress);
      await syncTemplates(db, accountSender, dest, result, progress);
      await setSetting(db, KEYS.lastSync, String(Date.now()));
      progress(1, 'Done');
      return result;
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------------------------------------------------------------- shared templates

/**
 * Templates shared with a group (a league or a team's scorekeepers), and the registry of
 * templates other scorekeepers have taught InkStat. The server keeps only part boxes and
 * printed scoresheet words, never a photo, so a downloaded template has `photoUri: null`
 * and its id is the server's, not the id of the phone that made it.
 */

export interface SharedBy {
  userId: string | null;
  name: string | null;
}

export interface GroupTemplateChange {
  /** The server's template id. */
  id: string;
  deleted: boolean;
  updatedAt: number;
  seq: number;
  /** Null when unshared. */
  data: ScorebookTemplate | null;
  sharedBy: SharedBy | null;
  sharedAt: number | null;
  /** This account shared it. */
  mine: boolean;
}

export interface SharedTemplate {
  template: ScorebookTemplate;
  sharedBy: SharedBy | null;
  sharedAt: number | null;
  mine: boolean;
  seq: number;
}

export interface PublishedTemplate extends SharedTemplate {
  /** Anchors left out because they weren't printed scoresheet words (names and the like). */
  droppedAnchors: number;
  /** False when this updated a template already shared. */
  created: boolean;
}

export interface PopularTemplate {
  id: string;
  name: string;
  sport: string;
  /** Distinct scorekeepers who published, shared or used it. */
  users: number;
  teams: number;
  groups: number;
  lastUsed: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new SyncError(e instanceof ApiError ? e.message : String(e));
  }
  if (!res.ok) throw new SyncError(await detail(res));
  return { status: res.status, data: (res.status === 204 ? undefined : await res.json()) as T };
}

const groupPath = (groupId: string, rest = '') => `/v1/groups/${encodeURIComponent(groupId)}/templates${rest}`;

/**
 * Shares one of this phone's templates with a group. Publishing the same template again
 * updates the group's copy instead of adding another. The photo path is never sent.
 */
export async function publishTemplateToGroup(groupId: string, template: ScorebookTemplate): Promise<PublishedTemplate> {
  const { status, data } = await request<Omit<PublishedTemplate, 'created'>>('POST', groupPath(groupId), { ...template, photoUri: null });
  return { ...data, created: status === 201 };
}

/** Shares a template already on the server (one from browseTemplates, or another group) with a group. */
export async function shareTemplateWithGroup(groupId: string, templateId: string): Promise<SharedTemplate> {
  return (await request<SharedTemplate>('POST', groupPath(groupId), { templateId })).data;
}

/** One page of a group's template changes since `since` (0 for everything), oldest first. */
export async function listGroupTemplates(
  groupId: string,
  since = 0,
): Promise<{ changes: GroupTemplateChange[]; cursor: number; more: boolean }> {
  return (await request<{ changes: GroupTemplateChange[]; cursor: number; more: boolean }>('GET', groupPath(groupId, `?since=${since}`))).data;
}

/**
 * Every change to a group's templates since `since`, all pages. Keep `cursor` to ask for
 * only what changed next time; `removed` lists ids unshared since then.
 */
export async function downloadGroupTemplates(
  groupId: string,
  since = 0,
): Promise<{ templates: GroupTemplateChange[]; removed: string[]; cursor: number }> {
  const latest = new Map<string, GroupTemplateChange>();
  let cursor = since;
  for (;;) {
    const page = await listGroupTemplates(groupId, cursor);
    for (const c of page.changes) latest.set(c.id, c);
    cursor = page.cursor;
    if (!page.more) break;
  }
  const all = [...latest.values()];
  return {
    templates: all.filter((c) => !c.deleted && c.data).map((c) => ({ ...c, data: { ...c.data!, photoUri: null } })),
    removed: all.filter((c) => c.deleted).map((c) => c.id),
    cursor,
  };
}

/** One template shared with a group. */
export async function getGroupTemplate(groupId: string, templateId: string): Promise<SharedTemplate> {
  const { data } = await request<SharedTemplate>('GET', groupPath(groupId, `/${encodeURIComponent(templateId)}`));
  return { ...data, template: { ...data.template, photoUri: null } };
}

/** Takes a template back out of a group. Only whoever shared it, or a group owner. */
export async function unshareGroupTemplate(groupId: string, templateId: string): Promise<void> {
  await request<void>('DELETE', groupPath(groupId, `/${encodeURIComponent(templateId)}`));
}

/** Widely used templates for a sport, most scorekeepers first, optionally matching a name. */
export async function browseTemplates(
  options: { sport?: string; q?: string; limit?: number } = {},
): Promise<PopularTemplate[]> {
  const params = new URLSearchParams({ sport: options.sport ?? 'basketball' });
  if (options.q) params.set('q', options.q);
  if (options.limit) params.set('limit', String(options.limit));
  return (await request<{ templates: PopularTemplate[] }>('GET', `/v1/templates?${params}`)).data.templates;
}

export { SyncError };
