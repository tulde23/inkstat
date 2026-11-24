import { anchorsForTemplate, applyAffine, bandOf, mapRect, matchLayout, type LayoutMatch, type TextLine } from '@inkstat/ocr-engine';

import type { FormTemplate, RowTable, TableDef } from './types';

/**
 * Recognising a form from its printed labels, and lining a template up with a
 * new photo: the template's anchors are matched to the words found on the photo,
 * and every box is mapped through the fitted transform.
 */

const MIN_SCORE = 0.25;
const MIN_INLIERS = 8;

export interface FormMatch {
  template: FormTemplate;
  match: LayoutMatch;
}

/** The template whose labels best agree with this photo's words, if one agrees well enough. */
export function recognize(lines: TextLine[], templates: FormTemplate[]): FormMatch | null {
  let best: FormMatch | null = null;
  for (const t of templates) {
    if (!t.anchors?.length) continue;
    const match = matchLayout(t.anchors, lines);
    if (!match || match.score < MIN_SCORE || match.inliers < MIN_INLIERS) continue;
    if (!best || match.score > best.match.score) best = { template: t, match };
  }
  return best;
}

/**
 * A row table on a turned photo. Its rows slope, so it is kept as the slope plus
 * the box measured at its left edge (top and height there): the engine then
 * crops each column slice at its own height. Each column's left edge is mapped
 * as a line, so it leans with the page.
 */
function alignRowTable(t: RowTable, m: LayoutMatch): RowTable {
  const T = m.transform;
  const r = t.rect!;
  const tl = applyAffine(T, r.x, r.y);
  const tr = applyAffine(T, r.x + r.w, r.y);
  const bl = applyAffine(T, r.x, r.y + r.h);
  const slope = (tr.y - tl.y) / (tr.x - tl.x);
  const box = mapRect(T, r);
  // A point's height as if moved along its row to the box's left edge.
  const level = (p: { x: number; y: number }) => p.y - slope * (p.x - box.x);
  const top = level(tl);
  const bottom = level(bl);
  const rect = { x: box.x, y: top, w: box.w, h: bottom - top };
  const midY = r.y + r.h / 2;
  return {
    ...t,
    rect,
    slope,
    columns: t.columns.map((c) => {
      if (!c.band) return c;
      const lean = c.band.lean ?? 0;
      const a = applyAffine(T, c.band.x, r.y);
      const b = applyAffine(T, c.band.x + lean, r.y + r.h);
      // The column's left edge as a line in levelled heights, read at the box's top and bottom.
      const la = level(a);
      const lb = level(b);
      const xAt = (y: number) => (Math.abs(lb - la) < 1e-9 ? a.x : a.x + ((b.x - a.x) * (y - la)) / (lb - la));
      const midX = c.band.x + lean / 2;
      const w = applyAffine(T, midX + c.band.w, midY).x - applyAffine(T, midX, midY).x;
      const x = xAt(top);
      return { ...c, band: bandOf(x, Math.max(0.005, w), xAt(bottom) - x) };
    }),
  };
}

function alignTable(t: TableDef, m: LayoutMatch): TableDef {
  if (!t.rect) return t;
  const rect = mapRect(m.transform, t.rect);
  if (t.orientation === 'rows') return alignRowTable(t, m);
  // Sideways table: each printed row keeps its height where it starts (the table's left
  // edge) and slopes with the page, so each cell is cropped at its own height.
  const T = m.transform;
  const left = t.rect.x;
  const p0 = applyAffine(T, left, t.rect.y);
  const p1 = applyAffine(T, left + t.rect.w, t.rect.y);
  const slope = (p1.y - p0.y) / (p1.x - p0.x);
  const midY = t.rect.y + t.rect.h / 2;
  const cx0 = applyAffine(T, t.cells.x, midY).x;
  const cx1 = applyAffine(T, t.cells.x + t.cells.w, midY).x;
  return {
    ...t,
    rect,
    slope,
    cells: { x: cx0, w: cx1 - cx0 },
    fields: t.fields.map((f) => {
      if (!f.band) return f;
      // Where the row's top and bottom edges cross the table's (mapped) left edge.
      const top = applyAffine(T, left, f.band.y);
      const bottom = applyAffine(T, left, f.band.y + f.band.h);
      const y0 = top.y + slope * (rect.x - top.x);
      const y1 = bottom.y + slope * (rect.x - bottom.x);
      return { ...f, band: { y: y0, h: y1 - y0 } };
    }),
  };
}

/** The template with every box moved onto this photo. */
export function alignTemplate(t: FormTemplate, m: LayoutMatch): FormTemplate {
  return {
    ...t,
    fields: t.fields.map((f) => (f.rect ? { ...f, rect: mapRect(m.transform, f.rect) } : f)),
    tables: t.tables.map((table) => alignTable(table, m)),
  };
}

/**
 * The template to read this photo with: lined up by its labels when they are
 * found, as saved otherwise (a photo framed like the template's own).
 */
export function templateForPhoto(t: FormTemplate, lines: TextLine[] | null): { template: FormTemplate; aligned: boolean } {
  if (!lines || !t.anchors?.length) return { template: t, aligned: false };
  const m = matchLayout(t.anchors, lines);
  if (!m || m.score < MIN_SCORE || m.inliers < MIN_INLIERS) return { template: t, aligned: false };
  return { template: alignTemplate(t, m), aligned: true };
}

/** A user's own template from a built-in or a fresh photo: anchors kept so later photos line up. */
export function newFormTemplate(from: FormTemplate | null, id: string, name: string, photoUri: string | null, lines: TextLine[] | null, now = Date.now()): FormTemplate {
  return {
    kind: 'form',
    version: 1,
    id,
    name,
    fields: from?.fields ?? [],
    tables: from?.tables ?? [],
    checks: from?.checks ?? [],
    anchors: lines ? anchorsForTemplate(lines) : from?.anchors,
    builtinId: from?.builtinId,
    description: from?.description,
    source: from?.source,
    photoUri,
    createdAt: now,
    updatedAt: now,
  };
}
