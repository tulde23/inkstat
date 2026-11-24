import type { FieldSchema } from '@inkstat/ocr-engine';

import type { FieldDef, TimeTemp, Value } from './types';

/** How each kind is asked for: strings for anything written, so the model copies rather than computes. */
export function schemaFor(f: FieldDef): FieldSchema {
  const what = describe(f);
  switch (f.kind) {
    case 'checkbox':
      return { type: 'boolean', nullable: true, description: `is "${f.label}" ticked, crossed or filled in` };
    case 'choice':
      return { type: 'string', nullable: true, enum: f.options, description: `which of these is ticked or circled: ${f.options?.join(', ')}` };
    default:
      return { type: 'string', nullable: true, description: what };
  }
}

/** The value as the model is told about it, e.g. `"Slump" in in., a number`. */
export function describe(f: FieldDef): string {
  const kind: Record<FieldDef['kind'], string> = {
    text: 'text',
    number: 'a number',
    integer: 'a whole number',
    date: 'a date',
    time: 'a time',
    checkbox: 'a tick box',
    choice: 'a choice',
    timeTemp: 'a time and a temperature, like 2:15/68',
  };
  return [`"${f.label}"`, f.unit ? `in ${f.unit}` : '', kind[f.kind], f.hint ?? ''].filter(Boolean).join(', ');
}

/** A number, then at most a unit after it ("12.5 psi", "68°F", "9.8%"). */
const NUMBER = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:[a-z°%"'²³/.]+\s*)?$/i;

/** "1,234.5", "12.5 psi", "68°" → number; null when there is no clear number ("about 7", "12+50"). */
export function parseNumber(text: string): number | null {
  const m = text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(NUMBER);
  return m ? Number(m[1]) : null;
}

/** "9:30", "930", "9.30am" → "09:30" (24-hour when am/pm is written); null when unclear. */
export function parseTime(text: string): string | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})[:.]?(\d{2})\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]?.startsWith('p') && h < 12) h += 12;
  if (m[3]?.startsWith('a') && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** US forms: "4/7/26", "04/07/2026", "2026-04-07" → "2026-04-07"; null when unclear. */
export function parseDate(text: string): string | null {
  const t = text.trim().replace(/\s+/g, '');
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
    if (!m) return null;
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2:15/68", "2:15 68°F", "68 @ 2:15" → { time, temp }. */
export function parseTimeTemp(text: string): TimeTemp | null {
  const t = text.trim();
  const time = t.match(/\d{1,2}[:.]\d{2}\s*(am|pm|a|p)?/i);
  const rest = time ? t.replace(time[0], ' ') : t;
  const temp = rest.match(/-?\d+(\.\d+)?/);
  if (!time && !temp) return null;
  return { time: time ? parseTime(time[0]) : null, temp: temp ? Number(temp[0]) : null };
}

/**
 * A raw answer turned into its kind. Text that doesn't parse is kept as written
 * (the caller records an issue), so nothing the model read is thrown away.
 */
export function parseValue(f: FieldDef, raw: unknown): { value: Value; ok: boolean } {
  if (raw === null || raw === undefined) return { value: null, ok: true };
  if (f.kind === 'checkbox') {
    if (typeof raw === 'boolean') return { value: raw, ok: true };
    const t = String(raw).trim().toLowerCase();
    if (['yes', 'y', 'true', 'x', '✓', 'checked', 'ticked'].includes(t)) return { value: true, ok: true };
    if (['no', 'n', 'false', '', 'blank', 'unchecked'].includes(t)) return { value: false, ok: true };
    return { value: String(raw), ok: false };
  }
  const text = String(raw).trim();
  if (!text || /^(n\/?a|null|none|-+)$/i.test(text)) return { value: null, ok: true };
  switch (f.kind) {
    case 'number':
    case 'integer': {
      const n = parseNumber(text);
      if (n === null || (f.kind === 'integer' && !Number.isInteger(n))) return { value: text, ok: false };
      return { value: n, ok: true };
    }
    case 'date': {
      const d = parseDate(text);
      return d ? { value: d, ok: true } : { value: text, ok: false };
    }
    case 'time': {
      const t = parseTime(text);
      return t ? { value: t, ok: true } : { value: text, ok: false };
    }
    case 'timeTemp': {
      const v = parseTimeTemp(text);
      return v ? { value: v, ok: true } : { value: text, ok: false };
    }
    case 'choice': {
      const hit = f.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      return hit ? { value: hit, ok: true } : { value: text, ok: false };
    }
    default:
      return { value: text, ok: true };
  }
}
