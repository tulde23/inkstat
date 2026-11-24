import { resultsFor, type DocumentTemplate, type ExtractionRun, type FieldSchema, type PieceSpec, type RegionSpec } from '@inkstat/ocr-engine';

import type { ColumnTable, DataRow, FormData, FormTemplate, RowTable, TableColumn, Value } from './types';
import { describe, parseValue, schemaFor } from './values';

/**
 * Reading a form with its template. Lessons from scorebooks carry over:
 * - each single field is read from its own small box, enlarged;
 * - a table is read in strips, and each column beside the key column in its own
 *   narrow pass (one wide image of many columns loses values and shifts rows);
 * - a sideways table (one record per column) is read one printed row at a time,
 *   with its printed label, so the model always knows which value it is reading.
 */

const SYSTEM =
  'You transcribe paper forms exactly as written, printed or handwritten. ' +
  'Copy numbers digit for digit and never calculate, correct or invent a value. ' +
  'If a box is blank or you cannot read it, use null.';

export const fieldRegion = (id: string) => `field_${id}`;
export const passRegion = (table: string, column: string) => `table_${table}_${column}`;
export const rowRegion = (table: string, field: string) => `table_${table}_${field}`;

const KEY = '_key';

/** The column passes of a row table: [column, ...] per pass, the key column first when there is one. */
export function passesOf(t: RowTable): TableColumn[][] {
  const placed = t.columns.filter((c) => c.band);
  const key = placed.find((c) => c.id === t.key);
  if (!key) return placed.length ? [placed] : [];
  return placed.filter((c) => c !== key).map((c) => [key, c]);
}

function rowTableRegions(t: RowTable): RegionSpec[] {
  if (!t.rect) return [];
  return passesOf(t).map((cols): RegionSpec => {
    const keyed = cols.length === 2 && cols[0].id === t.key;
    const properties: Record<string, FieldSchema> = {};
    for (const c of cols) properties[keyed && c === cols[0] ? KEY : c.id] = schemaFor(c);
    const what = cols.map((c) => describe(c)).join('; ');
    const id = keyed ? passRegion(t.id, cols[1].id) : passRegion(t.id, 'all');
    return {
      id,
      label: `${t.label}: ${keyed ? cols[1].label : 'all columns'}`,
      rect: t.rect!,
      columns: cols.map((c) => ({ ...c.band!, label: c.label })).sort((a, b) => a.x - b.x),
      joinColumns: true,
      slope: t.slope,
      tiles: { targetAspect: 1.2, overlap: 0.1, minRows: 1, maxRows: Math.max(1, Math.ceil(t.maxRows / 3)) },
      maxImageSide: 2048,
      maxTokens: 60 + 40 * Math.min(t.maxRows, 12) * cols.length,
      prompt:
        `These are rows of the "${t.label}" table on a paper form, columns left to right: ${what}. ` +
        'Give one item per filled-in row, top to bottom, with each column as written. ' +
        'Use null for a blank cell. Skip empty rows and printed headings.',
      schema: { type: 'object', properties: { rows: { type: 'array', maxItems: t.maxRows, items: { type: 'object', properties } } } },
    };
  });
}

/**
 * One printed row of a sideways table as pieces: its label, then each record's
 * cell, each cropped at its own height (rows of a turned photo slope), joined
 * side by side into one image.
 */
export function rowPieces(t: ColumnTable, band: { y: number; h: number }): PieceSpec[] {
  const rect = t.rect!;
  const slope = t.slope ?? 0;
  const at = (x: number, w: number, label: string): PieceSpec => ({
    rect: { x, w, y: band.y + slope * (x + w / 2 - rect.x), h: band.h },
    label,
  });
  const cw = t.cells.w / t.records;
  return [
    at(rect.x, t.cells.x - rect.x, 'the printed label'),
    ...Array.from({ length: t.records }, (_, i) => at(t.cells.x + i * cw, cw, `box ${i + 1}`)),
  ];
}

function columnTableRegions(t: ColumnTable): RegionSpec[] {
  if (!t.rect) return [];
  return t.fields
    .filter((f) => f.band)
    .map((f) => ({
      id: rowRegion(t.id, f.id),
      label: `${t.label}: ${f.label}`,
      rect: { x: t.rect!.x, y: f.band!.y, w: t.rect!.w, h: f.band!.h },
      pieces: rowPieces(t, f.band!),
      maxImageSide: 1536,
      maxTokens: 30 + 25 * t.records,
      prompt:
        `This is one printed row of a form. The label at the left says "${f.label}". ` +
        `To its right are ${t.records} boxes, numbered 1 to ${t.records} from left to right. ` +
        `Give what is written in each box, in order, as ${describe(f)}. Use null for a blank box.`,
      schema: { type: 'object', properties: { values: { type: 'array', maxItems: t.records, items: schemaFor(f) } } },
    }));
}

/** The engine's reading plan for a form template. */
export function documentFor(t: FormTemplate): DocumentTemplate {
  const regions: RegionSpec[] = [];
  for (const f of t.fields) {
    if (!f.rect) continue;
    regions.push({
      id: fieldRegion(f.id),
      label: f.label,
      rect: f.rect,
      maxImageSide: 1024,
      maxTokens: 60,
      prompt:
        f.kind === 'checkbox'
          ? `This box is from a paper form, labelled "${f.label}". Is it ticked, crossed or filled in?`
          : f.kind === 'choice'
            ? `This part of a paper form, "${f.label}", has these options: ${f.options?.join(', ')}. Which one is ticked, crossed or circled? Use null if none.`
            : `This box is from a paper form and holds ${describe(f)}. Copy it exactly as written. Use null if it is blank.`,
      schema: { type: 'object', properties: { value: schemaFor(f) } },
    });
  }
  for (const table of t.tables) regions.push(...(table.orientation === 'rows' ? rowTableRegions(table) : columnTableRegions(table)));
  return { id: `form.${t.id}`, name: t.name, version: 1, systemPrompt: SYSTEM, regions };
}

const keyOf = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function readRowTable(t: RowTable, run: ExtractionRun, issues: string[]): DataRow[] {
  const byId = Object.fromEntries(t.columns.map((c) => [c.id, c]));
  const empty = (): DataRow => Object.fromEntries(t.columns.map((c) => [c.id, null]));
  const put = (row: DataRow, col: TableColumn, raw: unknown, where: string) => {
    if (row[col.id] !== null) return; // first strip that read it wins (strips overlap)
    const { value, ok } = parseValue(col, raw);
    if (!ok) issues.push(`${where} ${col.label}: "${String(raw)}" isn't ${describe(col)}`);
    row[col.id] = value;
  };

  const passes = passesOf(t);
  const keyed = passes.length > 0 && passes[0].length === 2 && passes[0][0].id === t.key;

  if (!keyed) {
    // One pass of every column: rows in reading order; overlapping strips repeat a row exactly.
    const out: DataRow[] = [];
    const seen = new Set<string>();
    for (const tile of resultsFor(run, passRegion(t.id, 'all'))) {
      const rows = (tile.data as { rows?: Record<string, unknown>[] } | null)?.rows;
      if (!rows) {
        issues.push(`${t.label}: strip ${tile.tileIndex + 1} couldn't be read`);
        continue;
      }
      for (const r of rows) {
        const sig = JSON.stringify(t.columns.map((c) => r[c.id] ?? null));
        if (seen.has(sig) || t.columns.every((c) => r[c.id] == null)) continue;
        seen.add(sig);
        const row = empty();
        for (const c of t.columns) put(row, c, r[c.id], `${t.label} row ${out.length + 1}`);
        out.push(row);
      }
    }
    return out;
  }

  // Keyed: each pass gives (key, value) items, matched to rows by the key. Small models
  // sometimes run several rows' keys together ("Chili Rice Turkey stock"), leave the key
  // out, or copy a printed heading as if it were a row; each is handled below.
  const printed = new Set([t.label, ...t.columns.map((c) => c.label)].map(keyOf));
  type Item = { k: string; key: unknown; raw: unknown };
  const items = passes.map(([, col]) => {
    const list: Item[] = [];
    for (const tile of resultsFor(run, passRegion(t.id, col.id))) {
      const rows = (tile.data as { rows?: Record<string, unknown>[] } | null)?.rows;
      if (!rows) {
        issues.push(`${t.label} ${col.label}: strip ${tile.tileIndex + 1} couldn't be read`);
        continue;
      }
      for (const r of rows) {
        let k = keyOf(r[KEY]);
        if (printed.has(k) || k === 'null') k = '';
        const raw = r[col.id] ?? null;
        if (!k && raw === null) continue;
        // The same row again where strips overlap.
        if (k && list.some((x) => x.k === k)) continue;
        list.push({ k, key: r[KEY], raw });
      }
    }
    return { col, list };
  });

  // Row order: from the pass that told the most rows apart, then any rows only others saw.
  const keysOf = (list: Item[]) => [...new Set(list.map((x) => x.k).filter(Boolean))];
  const best = items.reduce((a, b) => (keysOf(b.list).length > keysOf(a.list).length ? b : a), items[0]);
  const order = keysOf(best.list);
  const lumped = (k: string) => order.filter((o) => o !== k && k.includes(o)).length >= 2;
  for (const { list } of items) for (const k of keysOf(list)) if (!order.includes(k) && !lumped(k)) order.push(k);

  const rows = new Map<string, DataRow>();
  const keyCol = byId[t.key!];
  for (const k of order) {
    const row = empty();
    const first = items.flatMap((x) => x.list).find((x) => x.k === k)!;
    put(row, keyCol, first.key, `${t.label} row ${rows.size + 1}`);
    rows.set(k, row);
  }
  // No keys read at all: as many rows as the fullest pass, filled by position.
  if (!rows.size) {
    const n = Math.max(0, ...items.map((x) => x.list.filter((i) => i.raw !== null).length));
    for (let i = 0; i < n; i++) rows.set(`#${i}`, empty());
  }

  for (const { col, list } of items) {
    const loose: Item[] = [];
    for (const x of list) {
      const row = rows.get(x.k);
      if (row) put(row, col, x.raw, `${t.label} "${String(x.key)}"`);
      else if (x.raw !== null) loose.push(x);
    }
    if (!loose.length) continue;
    // Values read without their row's key: top to bottom onto the rows still missing this
    // column, when that is unambiguous; otherwise say so rather than guess.
    const open = [...rows.values()].filter((r) => r[col.id] === null);
    if (loose.every((x) => !x.k) && loose.length <= open.length) {
      loose.forEach((x, i) => put(open[i], col, x.raw, `${t.label} row ${i + 1}`));
      issues.push(`${t.label} ${col.label}: matched to rows by position (the ${keyCol.label.toLowerCase()} wasn't read beside it)`);
    } else {
      issues.push(`${t.label} ${col.label}: couldn't tell which row ${loose.map((x) => `"${String(x.raw)}"`).join(', ')} belong${loose.length === 1 ? 's' : ''} to`);
    }
  }
  return [...rows.values()];
}

function readColumnTable(t: ColumnTable, run: ExtractionRun, issues: string[]): DataRow[] {
  const records: DataRow[] = Array.from({ length: t.records }, () => Object.fromEntries(t.fields.map((f) => [f.id, null as Value])));
  for (const f of t.fields) {
    const [r] = resultsFor(run, rowRegion(t.id, f.id));
    if (!r) continue;
    const values = (r.data as { values?: unknown[] } | null)?.values;
    if (!values) {
      issues.push(`${t.label} ${f.label}: couldn't be read`);
      continue;
    }
    values.slice(0, t.records).forEach((raw, i) => {
      const { value, ok } = parseValue(f, raw);
      if (!ok) issues.push(`${t.label} ${i + 1} ${f.label}: "${String(raw)}" isn't ${describe(f)}`);
      records[i][f.id] = value;
    });
  }
  // Records with nothing written are left out (a form with room for 4 tests, 2 done).
  return records.filter((rec) => Object.values(rec).some((v) => v !== null && v !== false));
}

/** What the photo says, as data, from an extraction run of documentFor(t). */
export function readForm(t: FormTemplate, run: ExtractionRun, now = Date.now()): FormData {
  const issues: string[] = [];
  const fields: Record<string, Value> = {};
  for (const f of t.fields) {
    fields[f.id] = null;
    if (!f.rect) continue;
    const [r] = resultsFor(run, fieldRegion(f.id));
    if (!r) continue;
    if (!r.data) {
      issues.push(`${f.label}: couldn't be read`);
      continue;
    }
    const raw = (r.data as { value?: unknown }).value;
    const { value, ok } = parseValue(f, raw);
    if (!ok) issues.push(`${f.label}: "${String(raw)}" isn't ${describe(f)}`);
    fields[f.id] = value;
  }
  const tables: Record<string, DataRow[]> = {};
  for (const table of t.tables) {
    tables[table.id] = table.orientation === 'rows' ? readRowTable(table, run, issues) : readColumnTable(table, run, issues);
  }
  return { template: { id: t.id, name: t.name }, source: run.sourceUri, readAt: now, fields, tables, issues };
}
