import { anchorsFrom, applyAffine, mapRect, matchLayout, type Anchor, type LayoutMatch } from './align';
import type { DocumentTemplate, ExtractionRun, NormRect, TextLine, TextWord } from './types';

/**
 * Templates for any kind of paper form, any sport.
 *
 * A sport supplies a region bank (its catalog of parts: what each is, its shape,
 * variants, how well it reads today, the printed words that usually label it)
 * and how to read and check a page. Everything else is shared: the template
 * format, readiness, variants, suggesting what a drawn box is, lining a template
 * up with a new photo, and a library of built-in layouts.
 */

/** A column inside the table rows: only its left edge and width; it spans the rows box. */
export interface Band {
  x: number;
  w: number;
  /**
   * How far the column's left edge moves sideways from the top of the rows box to the
   * bottom (fraction of page width): a column that leans on a tilted photo or an unevenly
   * printed form. Left out (or 0) for a straight column.
   */
  lean?: number;
}

/** A band as stored: the lean is kept only when it is more than a hair. */
export const bandOf = (x: number, w: number, lean = 0): Band => (Math.abs(lean) >= 0.001 ? { x, w, lean } : { x, w });

export type PartShape = 'box' | 'band';

/** How well a part reads today: measured on the test bench, or 'untested' before that. */
export type PartStatus = 'strong' | 'ok' | 'weak' | 'untested' | 'planned';

export interface PartVariant {
  id: string;
  name: string;
  sub: string;
}

export interface PartSpec<Id extends string = string, G extends string = string> {
  id: Id;
  name: string;
  group: G;
  /** A box anywhere on the page, or a band (column) across the table rows. */
  shape: PartShape;
  status: PartStatus;
  /** Ways a form can write this; picked once per template. The first is the default. */
  variants?: PartVariant[];
  /** Printed words near this part on most forms (lower case, letters and digits). */
  labels: string[];
  /** What to do, shown on the marking step. */
  instruction: string;
  /** Why it's needed, shown on the marking step. */
  why: string;
  /** Shorter reason for lists. */
  short: string;
  /** Box color in the builder; also differs in lightness, and every box is labelled. */
  color: string;
}

export interface PartGroupSpec<G extends string = string> {
  group: G;
  title: string;
  shape: string;
}

/** A sport's region bank. */
export interface Catalog<Id extends string = string, G extends string = string> {
  parts: PartSpec<Id, G>[];
  groups: PartGroupSpec<G>[];
  /** The part whose box holds the table rows; band parts are columns of it. */
  rowsPart: Id;
  /** A template can read pages once these are marked. */
  required: Id[];
  /** Parts a new template asks for. */
  defaultEnabled: Id[];
  /** Where each part's box starts before it is moved. */
  defaults: Record<Id, NormRect | Band>;
  /** Groups whose parts are marked together on one wizard step (e.g. header fields). */
  sharedStepGroups?: G[];
}

export interface Template<Id extends string = string> {
  version: 3;
  /** Which sport's catalog the parts come from. */
  sport: string;
  id: string;
  name: string;
  /** Parts chosen to read, whether or not each is marked yet. */
  enabled: Id[];
  /** Where each marked part is. Bands span the rows box. */
  parts: Partial<Record<Id, NormRect | Band>>;
  /** How this form writes each part that has variants. */
  variants: Partial<Record<Id, string>>;
  /** The photo the template was made on, for editing and re-testing. */
  photoUri: string | null;
  /** Printed labels on that photo and where they were, to line later photos up. */
  anchors?: Anchor[];
  /** Built-in layout this template started from, if any. */
  builtinId?: string;
  /** How the page is laid out: one team (or entrant) per page, or both on one page and where home is. */
  sheet?: SheetLayout;
  /** Last test read on that photo. */
  test: { at: number; seconds: number; checks: number; problems: number } | null;
  createdAt: number;
  updatedAt: number;
}

/** Where the home team's half is on a page that holds both teams. */
export type HomeAt = 'top' | 'bottom' | 'left' | 'right';

/** One team per page (a book spread, or separate sheets), or both teams on one page. */
export interface SheetLayout {
  teams: 'one' | 'both';
  /** With both teams on the page: where home is. */
  homeAt?: HomeAt;
}

/** A built-in layout: a known form's printed labels and its boxes, in reference-image coordinates. */
export interface BuiltinLayout<Id extends string = string> {
  id: string;
  name: string;
  family: string;
  description: string;
  anchors: Anchor[];
  enabled: Id[];
  parts: Partial<Record<Id, NormRect | Band>>;
  variants: Partial<Record<Id, string>>;
  /** How the page is laid out; one team per page when left out. */
  sheet?: SheetLayout;
}

/** One line of a test read: what was read for a part and whether it looks right. */
export interface PartCheck<Id extends string = string> {
  part: Id;
  value: string;
  ok: boolean;
  note?: string;
}

export interface Placement<Id extends string = string> {
  parts: Partial<Record<Id, NormRect | Band>>;
  /** Parts placed from labels found on this page (the rest are guesses). */
  found: Id[];
}

/** A sport plugged into the shared template machinery. */
export interface SportModule<Id extends string = string, G extends string = string> {
  id: string;
  name: string;
  /** What one page is called, for copy: "scorebook page", "heat sheet". */
  pageNoun: string;
  catalog: Catalog<Id, G>;
  library: BuiltinLayout<Id>[];
  /** Starting boxes from the printed labels on a page. */
  placeParts(lines: TextLine[]): Placement<Id>;
  /** The page regions to read with this template. */
  documentFor(t: Template<Id>): DocumentTemplate;
  /** Per-part results of a read, with cross-checks. */
  checks(t: Template<Id>, run: ExtractionRun): PartCheck<Id>[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const specOf = <Id extends string>(c: Catalog<Id>, id: Id): PartSpec<Id> => {
  const s = c.parts.find((p) => p.id === id);
  if (!s) throw new Error(`Unknown part ${id}`);
  return s;
};

export const isBandPart = <Id extends string>(c: Catalog<Id>, id: Id) => specOf(c, id).shape === 'band';

export function newTemplate<Id extends string>(
  sport: string,
  c: Catalog<Id>,
  id: string,
  name: string,
  photoUri: string | null,
  now = Date.now(),
): Template<Id> {
  return { version: 3, sport, id, name, enabled: [...c.defaultEnabled], parts: {}, variants: {}, photoUri, test: null, createdAt: now, updatedAt: now };
}

/** Keep boxes inside the page and bands inside the rows box; drop parts the catalog doesn't know. */
export function normalizeTemplate<Id extends string>(t: Template<Id>, c: Catalog<Id>): Template<Id> {
  const parts: Template<Id>['parts'] = {};
  const box = (r: NormRect, min = 0.01): NormRect => {
    const x = clamp(r.x, 0, 1 - min);
    const y = clamp(r.y, 0, 1 - min);
    return { x, y, w: clamp(r.w, min, 1 - x), h: clamp(r.h, min, 1 - y) };
  };
  const rowsRaw = t.parts[c.rowsPart] as NormRect | undefined;
  const rows = rowsRaw ? box(rowsRaw, 0.05) : undefined;
  if (rows) parts[c.rowsPart] = rows;
  const known = new Set(c.parts.map((p) => p.id));
  for (const [id, value] of Object.entries(t.parts) as [Id, NormRect | Band | undefined][]) {
    if (id === c.rowsPart || !value || !known.has(id)) continue;
    if (isBandPart(c, id)) {
      const lo = rows?.x ?? 0;
      const hi = rows ? rows.x + rows.w : 1;
      const x = clamp(value.x, lo, hi - 0.01);
      const w = clamp(value.w, 0.01, hi - x);
      // The bottom of a leaning column stays inside the rows box too.
      const lean = (value as Band).lean ? clamp(x + (value as Band).lean!, lo, Math.max(lo, hi - w)) - x : 0;
      parts[id] = bandOf(x, w, lean);
    } else {
      parts[id] = box(value as NormRect);
    }
  }
  return { ...t, enabled: t.enabled.filter((id) => known.has(id)), parts };
}

/** Enabled parts not marked yet, in catalog order. */
export const unmarkedParts = <Id extends string>(t: Template<Id>, c: Catalog<Id>): Id[] =>
  c.parts.map((p) => p.id).filter((id) => t.enabled.includes(id) && !t.parts[id]);

/** Enabled and marked: what a read will use, in catalog order. */
export const markedParts = <Id extends string>(t: Template<Id>, c: Catalog<Id>): Id[] =>
  c.parts.map((p) => p.id).filter((id) => t.enabled.includes(id) && !!t.parts[id]);

/** A template can read pages once its required parts are marked. */
export const isUsable = <Id extends string>(t: Template<Id>, c: Catalog<Id>) =>
  c.required.every((id) => t.enabled.includes(id) && !!t.parts[id]);

/** The chosen variant of a part, or its default. */
export const variantOf = <Id extends string>(t: Pick<Template<Id>, 'variants'>, c: Catalog<Id>, id: Id): string | undefined =>
  t.variants?.[id] ?? specOf(c, id).variants?.[0].id;

/**
 * A part's full rect on the page; bands take their height from the rows box (or its
 * default). A leaning band gives the rect that holds all of it.
 */
export function fullRect<Id extends string>(t: Template<Id>, c: Catalog<Id>, id: Id): NormRect | null {
  const v = t.parts[id];
  if (!v) return null;
  if (!isBandPart(c, id)) return v as NormRect;
  const rows = (t.parts[c.rowsPart] ?? c.defaults[c.rowsPart]) as NormRect;
  const lean = (v as Band).lean ?? 0;
  return { x: v.x + Math.min(0, lean), w: v.w + Math.abs(lean), y: rows.y, h: rows.h };
}

const normWord = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Parts a box might be, best first, from the printed words in or just around it
 * (a column's heading sits above it; a field's label to its left).
 */
export function suggestParts<Id extends string>(rect: NormRect, lines: TextLine[], c: Catalog<Id>): Id[] {
  const words: TextWord[] = lines.flatMap((l) => (l.words.length ? l.words : [{ text: l.text, rect: l.rect }]));
  const tall = rect.h > 0.15;
  const zone = {
    x0: rect.x - (tall ? 0.01 : 0.15),
    x1: rect.x + rect.w + 0.01,
    y0: rect.y - (tall ? 0.06 : 0.02),
    y1: rect.y + (tall ? Math.min(rect.h, 0.04) : rect.h + 0.01),
  };
  const score = new Map<Id, number>();
  for (const w of words) {
    const x = w.rect.x + w.rect.w / 2;
    const y = w.rect.y + w.rect.h / 2;
    if (x < zone.x0 || x > zone.x1 || y < zone.y0 || y > zone.y1) continue;
    const t = normWord(w.text);
    for (const p of c.parts) {
      if (!p.labels.includes(t)) continue;
      // A tall box is a column of the table; a short one is a box.
      const fit = (p.shape === 'band') === tall ? 2 : 0.5;
      score.set(p.id, (score.get(p.id) ?? 0) + fit);
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** A match is believable when enough labels line up: a share of the layout's anchors, and a minimum count. */
const MIN_SCORE = 0.25;
const MIN_INLIERS = 6;

export interface LibraryMatch<Id extends string = string> {
  layout: BuiltinLayout<Id>;
  match: LayoutMatch;
}

/** The built-in layout this photo is, if any (best match by share of anchors found). */
export function matchLibrary<Id extends string>(lines: TextLine[], library: BuiltinLayout<Id>[]): LibraryMatch<Id> | null {
  let best: LibraryMatch<Id> | null = null;
  for (const layout of library) {
    const match = matchLayout(layout.anchors, lines);
    if (!match || match.score < MIN_SCORE || match.inliers < MIN_INLIERS) continue;
    if (!best || match.score > best.match.score) best = { layout, match };
  }
  return best;
}

/**
 * Parts mapped from reference coordinates onto a photo. A band's left edge is mapped
 * as a line, so on a rotated or tilted photo the column leans with the page instead of
 * becoming a wider straight box that takes in its neighbours.
 */
export function alignParts<Id extends string>(
  parts: Partial<Record<Id, NormRect | Band>>,
  match: LayoutMatch,
  c: Catalog<Id>,
): Partial<Record<Id, NormRect | Band>> {
  const rows = parts[c.rowsPart] as NormRect | undefined;
  const out: Partial<Record<Id, NormRect | Band>> = {};
  for (const [id, v] of Object.entries(parts) as [Id, NormRect | Band | undefined][]) {
    if (!v) continue;
    if (isBandPart(c, id)) {
      if (!rows) continue;
      out[id] = alignBand(v as Band, rows, match);
    } else {
      out[id] = mapRect(match.transform, v as NormRect);
    }
  }
  return out;
}

function alignBand(v: Band, rows: NormRect, match: LayoutMatch): Band {
  const T = match.transform;
  const lean = v.lean ?? 0;
  const box = mapRect(T, rows);
  const top = applyAffine(T, v.x, rows.y);
  const bottom = applyAffine(T, v.x + lean, rows.y + rows.h);
  // The left edge as a line, read where the mapped rows box starts and ends.
  const dy = bottom.y - top.y;
  const xAt = (y: number) => (Math.abs(dy) < 1e-9 ? top.x : top.x + ((bottom.x - top.x) * (y - top.y)) / dy);
  const x = xAt(box.y);
  const midY = rows.y + rows.h / 2;
  const midX = v.x + lean / 2;
  const w = applyAffine(T, midX + v.w, midY).x - applyAffine(T, midX, midY).x;
  return bandOf(x, Math.max(0.005, w), xAt(box.y + box.h) - x);
}

/** Anchors to keep with a template, so later photos can be lined up with it. */
export const anchorsForTemplate = (lines: TextLine[]): Anchor[] =>
  anchorsFrom(lines).map((a) => ({ text: a.text, x: Math.round(a.x * 1000) / 1000, y: Math.round(a.y * 1000) / 1000 }));

export type TemplateSource = 'aligned' | 'as-saved' | 'library' | 'none';

/**
 * The template to read this photo with: the given template lined up with the photo
 * when its saved labels match, else as saved; with no template, a built-in layout
 * the photo is recognised as.
 */
export function templateForPhoto<Id extends string, G extends string>(
  template: Template<Id> | null,
  lines: TextLine[] | null,
  sport: Pick<SportModule<Id, G>, 'id' | 'catalog' | 'library'>,
): { template: Template<Id> | null; source: TemplateSource; detail: string } {
  if (template) {
    if (template.anchors?.length && lines) {
      const m = matchLayout(template.anchors, lines);
      if (m && m.score >= MIN_SCORE && m.inliers >= MIN_INLIERS) {
        return { template: { ...template, parts: alignParts(template.parts, m, sport.catalog) }, source: 'aligned', detail: `${m.inliers}/${m.total} labels` };
      }
    }
    return { template, source: 'as-saved', detail: template.anchors?.length ? 'labels not found on this photo' : 'no saved labels' };
  }
  const lib = lines ? matchLibrary(lines, sport.library) : null;
  if (!lib) return { template: null, source: 'none', detail: '' };
  const now = Date.now();
  return {
    template: {
      version: 3,
      sport: sport.id,
      id: `builtin-${lib.layout.id}`,
      name: lib.layout.name,
      enabled: lib.layout.enabled,
      parts: alignParts(lib.layout.parts, lib.match, sport.catalog),
      variants: lib.layout.variants,
      photoUri: null,
      test: null,
      builtinId: lib.layout.id,
      createdAt: now,
      updatedAt: now,
    },
    source: 'library',
    detail: `${lib.layout.id} ${lib.match.inliers}/${lib.match.total} labels`,
  };
}

/**
 * Starting boxes for a form with a table: finds the printed heading row (the line
 * holding the most column labels from the catalog), puts the rows box under it,
 * a column band under each heading (edges halfway to the neighbouring headings),
 * and box parts just right of their printed label. A starting point to review,
 * for sports whose forms are regular (meet results, heat sheets).
 */
export function placeFromHeadings<Id extends string>(lines: TextLine[], c: Catalog<Id>): Placement<Id> {
  const words = lines.flatMap((l) => (l.words.length ? l.words : [{ text: l.text, rect: l.rect }]));
  const bands = c.parts.filter((p) => p.shape === 'band');
  const labelOf = (t: string) => bands.find((p) => p.labels.includes(normWord(t)));
  // Group heading candidates into rows by vertical centre.
  const hits = words.map((w) => ({ w, part: labelOf(w.text) })).filter((h) => h.part);
  let best: typeof hits = [];
  for (const h of hits) {
    const cy = h.w.rect.y + h.w.rect.h / 2;
    const row = hits.filter((o) => Math.abs(o.w.rect.y + o.w.rect.h / 2 - cy) < Math.max(h.w.rect.h, 0.008));
    const distinct = new Set(row.map((o) => o.part!.id)).size;
    if (distinct > new Set(best.map((o) => o.part!.id)).size) best = row;
  }
  const parts: Placement<Id>['parts'] = {};
  const found: Id[] = [];
  if (new Set(best.map((o) => o.part!.id)).size >= 2) {
    const heads = [...best].sort((a, b) => a.w.rect.x - b.w.rect.x);
    const top = Math.max(...heads.map((h) => h.w.rect.y + h.w.rect.h)) + 0.004;
    const left = Math.max(0, heads[0].w.rect.x - 0.02);
    const right = Math.min(1, heads[heads.length - 1].w.rect.x + heads[heads.length - 1].w.rect.w + 0.06);
    parts[c.rowsPart] = { x: left, y: top, w: right - left, h: Math.max(0.05, 0.97 - top) };
    found.push(c.rowsPart);
    heads.forEach((h, i) => {
      const id = h.part!.id;
      if (parts[id]) return;
      const x0 = i === 0 ? left : (heads[i - 1].w.rect.x + heads[i - 1].w.rect.w + h.w.rect.x) / 2;
      const x1 = i === heads.length - 1 ? right : (h.w.rect.x + h.w.rect.w + heads[i + 1].w.rect.x) / 2;
      parts[id] = { x: x0, w: Math.max(0.01, x1 - x0) };
      found.push(id);
    });
  }
  // Box parts: the area right of their printed label.
  for (const p of c.parts.filter((q) => q.shape === 'box' && q.id !== c.rowsPart)) {
    const label = words.find((w) => p.labels.includes(normWord(w.text)));
    if (!label) continue;
    const r = label.rect;
    parts[p.id] = { x: r.x + r.w + 0.005, y: Math.max(0, r.y - r.h * 0.6), w: Math.min(0.3, 0.995 - (r.x + r.w)), h: r.h * 2 };
    found.push(p.id);
  }
  return { parts, found };
}

/** A built-in layout as a template: reference boxes and anchors, lined up per photo by templateForPhoto. */
export function builtinTemplate<Id extends string>(layout: BuiltinLayout<Id>, sportId: string, now = Date.now()): Template<Id> {
  return {
    version: 3,
    sport: sportId,
    id: `builtin-${layout.id}`,
    name: layout.name,
    enabled: layout.enabled,
    parts: layout.parts,
    variants: layout.variants,
    photoUri: null,
    anchors: layout.anchors,
    builtinId: layout.id,
    sheet: layout.sheet ?? { teams: 'one' },
    test: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * What a photo is, before reading it:
 *   - sure: a known form; read it straight away.
 *   - partly: some printed labels match a known form, not enough to be sure; ask.
 *   - none: printed text was read but matches nothing known; teach InkStat this form.
 *   - notext: almost nothing printed was read; it's the photo (blur, dark, too far).
 */
export type Recognition<Id extends string = string> =
  | { kind: 'sure' | 'partly'; template: Template<Id>; match: LayoutMatch; spread: 'left' | 'right' | null; words: number }
  | { kind: 'none'; words: number }
  | { kind: 'notext'; words: number };

/** Fewer printed words than this and the photo itself is the problem. */
const MIN_WORDS = 6;
const SURE_AGREEMENT = 0.5;
const PARTLY_INLIERS = 4;
const PARTLY_SCORE = 0.12;
/** A one-team page covering less of the photo's width than this is half of a book spread. */
const SPREAD_WIDTH = 0.65;

/**
 * Recognise a photo against known forms: the user's (and their league's) templates
 * that have saved labels, then the built-in books. The best match wins; a template
 * made from a built-in book beats the book itself on a tie, since it may be adjusted.
 */
export function recognizeForm<Id extends string, G extends string>(
  lines: TextLine[],
  templates: Template<Id>[],
  sport: Pick<SportModule<Id, G>, 'id' | 'library'>,
): Recognition<Id> {
  const words = lines
    .flatMap((l) => (l.words.length ? l.words : [{ text: l.text }]))
    .filter((w) => /[a-z]{2,}/i.test(w.text)).length;
  if (words < MIN_WORDS) return { kind: 'notext', words };

  const own = templates.filter((t) => t.anchors?.length);
  const ownBuiltins = new Set(own.map((t) => t.builtinId).filter(Boolean));
  const candidates = [...own, ...sport.library.filter((l) => !ownBuiltins.has(l.id)).map((l) => builtinTemplate(l, sport.id))];

  let best: { template: Template<Id>; match: LayoutMatch } | null = null;
  for (const template of candidates) {
    const match = matchLayout(template.anchors!, lines);
    if (!match) continue;
    if (!best || match.score > best.match.score) best = { template, match };
  }
  if (!best) return { kind: 'none', words };
  const { template, match } = best;
  const sure = match.inliers >= MIN_INLIERS && match.score >= MIN_SCORE && match.agreement >= SURE_AGREEMENT;
  const partly = match.inliers >= PARTLY_INLIERS && match.score >= PARTLY_SCORE;
  if (!sure && !partly) return { kind: 'none', words };

  // A one-team page that fills only part of the photo's width: a book spread with both teams.
  let spread: 'left' | 'right' | null = null;
  if ((template.sheet?.teams ?? 'one') === 'one') {
    const page = mapRect(match.transform, { x: 0, y: 0, w: 1, h: 1 });
    if (page.w < SPREAD_WIDTH) spread = page.x + page.w / 2 < 0.5 ? 'left' : 'right';
  }
  return { kind: sure ? 'sure' : 'partly', template, match, spread, words };
}
