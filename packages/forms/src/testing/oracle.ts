import type { Affine, GenerateRequest, ImageOps, NormRect, TextLine, VisionBackend } from '@inkstat/ocr-engine';
import { applyAffine } from '@inkstat/ocr-engine';

import type { FormTemplate } from '../types';

/**
 * A simulated photo of a filled-in form, and a "perfect reader" for it.
 *
 * The page is a list of written values, each at a point on the page. Crops are
 * fake images whose URIs say which part of the page they show; the reader
 * answers each request with exactly the values whose point lies inside the
 * images it was sent. So reading is perfect, and everything else is real: the
 * template's boxes, alignment, the engine's strips, column slices and joining,
 * and putting the answers back together. A value a crop misses is a value the
 * real model could never have read.
 */

export interface Written {
  /** Where on the page (0..1). */
  x: number;
  y: number;
  text: string | boolean;
  field?: string;
  table?: string;
  column?: string;
  /** Row or record number, from 0. */
  index?: number;
}

export interface Truth {
  fields: Record<string, string | boolean>;
  /** Row tables: rows of column → text. Sideways tables: records of field → text. */
  tables: Record<string, Record<string, string | boolean>[]>;
}

/** Where a value is written on the blank form. */
export function writeTruth(t: FormTemplate, truth: Truth): Written[] {
  const out: Written[] = [];
  for (const f of t.fields) {
    const v = truth.fields[f.id];
    if (v === undefined || !f.rect) continue;
    out.push({ x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2, text: v, field: f.id });
  }
  for (const table of t.tables) {
    const rows = truth.tables[table.id] ?? [];
    rows.forEach((row, i) => {
      if (table.orientation === 'rows') {
        const rect = table.rect!;
        const h = rect.h / table.maxRows;
        for (const c of table.columns) {
          const v = row[c.id];
          if (v === undefined || !c.band) continue;
          out.push({ x: c.band.x + c.band.w / 2, y: rect.y + (i + 0.5) * h, text: v, table: table.id, column: c.id, index: i });
        }
      } else {
        const w = table.cells.w / table.records;
        for (const f of table.fields) {
          const v = row[f.id];
          if (v === undefined || !f.band) continue;
          out.push({ x: table.cells.x + (i + 0.5) * w, y: f.band.y + f.band.h / 2, text: v, table: table.id, column: f.id, index: i });
        }
      }
    });
  }
  return out;
}

/** The photo: the same page moved by `T` (shifted, scaled, turned). */
export const photograph = (page: Written[], T: Affine): Written[] => page.map((w) => ({ ...w, ...applyAffine(T, w.x, w.y) }));

/** The printed labels as OCR would find them on that photo. */
export function printedLines(t: FormTemplate, T: Affine): TextLine[] {
  return (t.anchors ?? []).map((a) => {
    const p = applyAffine(T, a.x, a.y);
    const rect = { x: p.x - 0.01, y: p.y - 0.005, w: 0.02, h: 0.01 };
    return { text: a.text, rect, words: [{ text: a.text, rect }] };
  });
}

/** A small turn and shift, like a phone held a little crooked: `deg` degrees about the page centre. */
export function tilt(deg: number, dx = 0, dy = 0, scale = 1): Affine {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a) * scale;
  const s = Math.sin(a) * scale;
  // Rotate about (0.5, 0.5), then shift.
  return { a: c, b: -s, c: 0.5 - c * 0.5 + s * 0.5 + dx, d: s, e: c, f: 0.5 - s * 0.5 - c * 0.5 + dy };
}

const W = 2000;
const H = 2600;

/** Fake image ops: a crop's URI names its page rectangle; a join names its parts. */
export const pageImages: ImageOps = {
  size: async () => ({ width: W, height: H }),
  crop: async (_uri, r) => `crop:${r.originX / W},${r.originY / H},${r.width / W},${r.height / H}`,
  join: async (uris) => `join:${uris.join('|')}`,
};

const cropsOf = (uris: string[]): NormRect[] =>
  uris
    .flatMap((u) => (u.startsWith('join:') ? u.slice(5).split('|') : [u]))
    .map((u) => {
      const [x, y, w, h] = u.slice(5).split(',').map(Number);
      return { x, y, w, h };
    });

const inside = (r: NormRect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** The perfect reader. `misread` changes what it "sees" for a value (to test that checks catch it). */
export function oracle(page: Written[], t: FormTemplate, misread: (w: Written) => string | boolean = (w) => w.text): VisionBackend & { calls: number } {
  const keyOf = Object.fromEntries(t.tables.filter((x) => x.orientation === 'rows').map((x) => [x.id, x.key]));
  const backend = {
    modelId: 'oracle',
    calls: 0,
    async generate(req: GenerateRequest) {
      backend.calls++;
      const crops = cropsOf(req.imageUris);
      const seen = page.filter((w) => crops.some((c) => inside(c, w)));
      const schema = req.jsonSchema as { properties: Record<string, { items?: { properties?: Record<string, unknown> } }> };
      const top = Object.keys(schema.properties)[0];
      let answer: unknown;
      if (top === 'value') {
        // A single box: the value written in it. A crop of a turned page can take in
        // a neighbour's value at its edge; the one asked about is the one in the middle.
        const c = crops[0];
        const d = (x: Written) => Math.hypot(x.x - (c.x + c.w / 2), x.y - (c.y + c.h / 2));
        const w = seen.filter((x) => x.field).sort((a, b) => d(a) - d(b))[0];
        answer = { value: w ? misread(w) : null };
      } else if (top === 'values') {
        // One printed row of a sideways table: a value per record column.
        const out: (string | boolean | null)[] = [];
        for (const w of seen.filter((x) => x.table)) out[w.index!] = misread(w);
        answer = { values: Array.from(out, (v) => v ?? null) };
      } else {
        // Table strips: one item per row seen, the columns asked for.
        const props = Object.keys(schema.properties.rows.items!.properties!);
        const rows = new Map<number, Record<string, unknown>>();
        for (const w of seen.filter((x) => x.table)) {
          const key = keyOf[w.table!];
          const prop = props.find((p) => (p === '_key' ? key === w.column : p === w.column));
          if (!prop) continue;
          if (!rows.has(w.index!)) rows.set(w.index!, Object.fromEntries(props.map((p) => [p, null])));
          rows.get(w.index!)![prop] = misread(w);
        }
        answer = { rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r) };
      }
      return { text: JSON.stringify(answer), hitTokenLimit: false, tokens: 10 };
    },
  };
  return backend;
}
