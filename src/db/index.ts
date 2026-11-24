import type { SQLiteDatabase } from 'expo-sqlite';

import type { CheckResult, FormData, FormTemplate } from '@inkstat/forms';

export const DB_NAME = 'inkstat.db';

/**
 * On the phone: the user's form templates, and every form read (what it said,
 * its checks, and the template lined up with that photo). Photos are files kept
 * beside the database, never uploaded.
 */
export async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS form_templates (
      id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS form_reads (
      id TEXT PRIMARY KEY NOT NULL,
      template_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS form_reads_by_time ON form_reads (created_at);
  `);
}

// ── Settings ──

export async function getSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export async function clearSetting(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync('DELETE FROM settings WHERE key = ?', key);
}

/** Set while a page is being read; still present at launch means the OS killed the app mid-read. */
export const READ_IN_PROGRESS_KEY = 'scan.readInProgress';

// ── Templates ──

export async function listTemplates(db: SQLiteDatabase): Promise<FormTemplate[]> {
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM form_templates ORDER BY updated_at DESC');
  return rows.map((r) => JSON.parse(r.data) as FormTemplate);
}

export async function getTemplate(db: SQLiteDatabase, id: string): Promise<FormTemplate | null> {
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM form_templates WHERE id = ?', id);
  return row ? (JSON.parse(row.data) as FormTemplate) : null;
}

export async function saveTemplate(db: SQLiteDatabase, t: FormTemplate): Promise<void> {
  await db.runAsync(
    `INSERT INTO form_templates (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    t.id,
    JSON.stringify(t),
    t.updatedAt,
  );
}

export async function deleteTemplate(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM form_templates WHERE id = ?', id);
}

// ── Reads ──

/** One photo of a form, read. */
export interface SavedRead {
  id: string;
  /** The template as lined up with this photo (its boxes are where they were read). */
  template: FormTemplate;
  photoUri: string;
  data: FormData;
  checks: CheckResult[];
  modelId: string;
  seconds: number;
  createdAt: number;
  updatedAt: number;
}

export async function saveRead(db: SQLiteDatabase, r: SavedRead): Promise<void> {
  await db.runAsync(
    `INSERT INTO form_reads (id, template_id, data, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    r.id,
    r.template.id,
    JSON.stringify(r),
    r.createdAt,
  );
}

export async function getRead(db: SQLiteDatabase, id: string): Promise<SavedRead | null> {
  const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM form_reads WHERE id = ?', id);
  return row ? (JSON.parse(row.data) as SavedRead) : null;
}

export async function listReads(db: SQLiteDatabase): Promise<SavedRead[]> {
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM form_reads ORDER BY created_at DESC');
  return rows.map((r) => JSON.parse(r.data) as SavedRead);
}

export async function deleteRead(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM form_reads WHERE id = ?', id);
}
