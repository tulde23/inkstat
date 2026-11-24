import type { CheckResult, DataRow, FormData, FormTemplate, Value } from './types';

/**
 * Standard outputs of a read:
 * - JSON: one document with the fields, every table and the checks;
 * - CSV: one file per table (a row per record, form fields repeated at the
 *   right so each file stands alone in a spreadsheet), plus fields.csv;
 * - YAML: the JSON document, for people who read it by eye.
 * Pairs (time/temperature) become two columns in CSV.
 */

export interface ExportDoc {
  form: string;
  template: string;
  source: string;
  readAt: string;
  fields: Record<string, Value>;
  tables: Record<string, DataRow[]>;
  checks: { passed: number; failed: number; skipped: number; failures: CheckResult[] };
  issues: string[];
}

export function toDocument(data: FormData, checks: CheckResult[]): ExportDoc {
  return {
    form: data.template.name,
    template: data.template.id,
    source: data.source,
    readAt: new Date(data.readAt).toISOString(),
    fields: data.fields,
    tables: data.tables,
    checks: {
      passed: checks.filter((c) => c.status === 'pass').length,
      failed: checks.filter((c) => c.status === 'fail').length,
      skipped: checks.filter((c) => c.status === 'skipped').length,
      failures: checks.filter((c) => c.status === 'fail'),
    },
    issues: data.issues,
  };
}

export const toJSON = (data: FormData, checks: CheckResult[]) => JSON.stringify(toDocument(data, checks), null, 2);

// ── CSV ──

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (cells: unknown[]) => cells.map(cell).join(',');

/** A value split into CSV columns: a pair gives `<id>_time`, `<id>_temp`. */
function flat(id: string, v: Value, pair: boolean): [string, unknown][] {
  if (pair) {
    const p = v && typeof v === 'object' ? v : null;
    return [
      [`${id}_time`, p?.time ?? (typeof v === 'string' ? v : null)],
      [`${id}_temp`, p?.temp ?? null],
    ];
  }
  return [[id, v]];
}

/** File name → CSV text. */
export function toCSV(t: FormTemplate, data: FormData): Record<string, string> {
  const files: Record<string, string> = {};
  const fieldCells = t.fields.flatMap((f) => flat(f.id, data.fields[f.id] ?? null, f.kind === 'timeTemp'));

  files['fields.csv'] = [
    line(['field', 'label', 'value', 'unit']),
    ...t.fields.map((f) => {
      const v = data.fields[f.id] ?? null;
      const shown = v && typeof v === 'object' ? `${v.time ?? ''}/${v.temp ?? ''}` : v;
      return line([f.id, f.label, shown, f.unit ?? '']);
    }),
  ].join('\r\n');

  for (const table of t.tables) {
    const defs = table.orientation === 'rows' ? table.columns : table.fields;
    const rows = data.tables[table.id] ?? [];
    const header = [table.orientation === 'columns' ? 'record' : 'row', ...defs.flatMap((d) => flat(d.id, null, d.kind === 'timeTemp').map(([k]) => k)), ...fieldCells.map(([k]) => k)];
    const body = rows.map((r, i) => line([i + 1, ...defs.flatMap((d) => flat(d.id, r[d.id] ?? null, d.kind === 'timeTemp').map(([, v]) => v)), ...fieldCells.map(([, v]) => v)]));
    files[`${table.id}.csv`] = [line(header), ...body].join('\r\n');
  }
  return files;
}

// ── YAML (the subset a JSON document needs) ──

const PLAIN = /^[A-Za-z_][A-Za-z0-9_ .\-/]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return PLAIN.test(s) && !RESERVED.test(s) && s.trim() === s ? s : JSON.stringify(s);
}

function yaml(v: unknown, indent: string): string {
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return v
      .map((item) => {
        if (item && typeof item === 'object') {
          const inner = yaml(item, indent + '  ');
          // First key on the dash line.
          return `\n${indent}- ${inner.trimStart()}`;
        }
        return `\n${indent}- ${scalar(item)}`;
      })
      .join('');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return ' {}';
    return entries
      .map(([k, val]) => {
        const key = PLAIN.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
        return val && typeof val === 'object' ? `\n${indent}${key}:${yaml(val, indent + '  ')}` : `\n${indent}${key}: ${scalar(val)}`;
      })
      .join('');
  }
  return ` ${scalar(v)}`;
}

export const toYAML = (data: FormData, checks: CheckResult[]) => yaml(toDocument(data, checks), '').trimStart() + '\n';
