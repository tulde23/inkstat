import { evaluate, Missing, namesIn, parseRule } from './formula';
import type { CheckResult, DataRow, FieldDef, FormData, FormTemplate, Value } from './types';

/**
 * The checks a read must pass: every number inside its field's range, and every
 * rule of the template. A rule whose values weren't read is skipped, not failed.
 * A failed check means a misread or a mistake on the paper; either way, look.
 */

/** A value as a number for rules: numbers, ticked boxes (1/0), and `.time`/`.temp` of a pair. */
function numberOf(v: Value, part?: string): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') {
    if (part === 'temp') return v.temp;
    if (part === 'time' && v.time) {
      const [h, m] = v.time.split(':').map(Number);
      return h * 60 + m;
    }
    return null;
  }
  return null;
}

function lookupIn(row: DataRow | null, fields: Record<string, Value>) {
  return (name: string): number | null => {
    const [id, part] = name.split('.');
    if (row && id in row) return numberOf(row[id], part);
    if (id in fields) return numberOf(fields[id], part);
    throw new Error(`Unknown name "${name}"`);
  };
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

function rangeChecks(defs: FieldDef[], values: DataRow, where: { table?: string; row?: number; prefix: string }): CheckResult[] {
  const out: CheckResult[] = [];
  for (const f of defs) {
    if (f.min === undefined && f.max === undefined) continue;
    const v = values[f.id];
    const n = typeof v === 'number' ? v : typeof v === 'object' && v ? v.temp : null;
    if (n === null || n === undefined) continue;
    const ok = (f.min === undefined || n >= f.min) && (f.max === undefined || n <= f.max);
    const range = f.min !== undefined && f.max !== undefined ? `${f.min}–${f.max}` : f.min !== undefined ? `at least ${f.min}` : `at most ${f.max}`;
    out.push({
      id: `range.${f.id}`,
      label: `${where.prefix}${f.label} in range`,
      ...(where.table ? { table: where.table, row: where.row } : {}),
      status: ok ? 'pass' : 'fail',
      detail: ok ? `${fmt(n)}${f.unit ? ` ${f.unit}` : ''}` : `${fmt(n)}${f.unit ? ` ${f.unit}` : ''} is outside ${range}`,
    });
  }
  return out;
}

export function runChecks(t: FormTemplate, data: FormData): CheckResult[] {
  const out: CheckResult[] = rangeChecks(t.fields, data.fields, { prefix: '' });
  for (const table of t.tables) {
    const defs = table.orientation === 'rows' ? table.columns : table.fields;
    (data.tables[table.id] ?? []).forEach((row, i) => out.push(...rangeChecks(defs, row, { table: table.id, row: i + 1, prefix: `${table.label} ${i + 1}: ` })));
  }

  for (const c of t.checks) {
    const node = parseRule(c.rule);
    const rows: (DataRow | null)[] = c.table ? (data.tables[c.table] ?? []) : [null];
    rows.forEach((row, i) => {
      const where = c.table ? { table: c.table, row: i + 1 } : {};
      const look = lookupIn(row, data.fields);
      try {
        const ok = evaluate(node, look, c.tolerance) !== 0;
        // Show the numbers the rule used, so a failure says what to look at.
        const used = [...new Set(namesIn(node))].map((n) => `${n} ${fmt(look(n)!)}`).join(', ');
        out.push({ id: c.id, label: c.label, ...where, status: ok ? 'pass' : 'fail', detail: ok ? used : `${c.rule} fails with ${used}` });
      } catch (e) {
        if (!(e instanceof Missing)) throw e;
        out.push({ id: c.id, label: c.label, ...where, status: 'skipped', detail: `${e.field} wasn't read` });
      }
    });
  }
  return out;
}
