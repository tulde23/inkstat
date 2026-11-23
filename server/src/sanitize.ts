import { CATALOG as BASKETBALL, LIBRARY } from '@inkstat/basketball';
import { TRACK_CATALOG } from '@inkstat/track';
import { z } from 'zod';

import { ApiError } from './errors';

/**
 * What a shared template may carry. A template is made on a filled-in page, and its
 * anchors come from that page's text, which can include players' names (minors). So a
 * shared layout keeps only:
 *   - part boxes for parts the sport's catalog knows;
 *   - anchors whose text is printed scoresheet vocabulary (catalog labels and the words
 *     on the built-in reference books), or a run of those words, or an ordinal.
 * Never the photo.
 */

const CATALOGS = { basketball: BASKETBALL, track: TRACK_CATALOG } as const;
export type Sport = keyof typeof CATALOGS;
export const SPORTS = Object.keys(CATALOGS) as Sport[];

const GENERIC = [
  'home', 'visitor', 'visitors', 'away', 'team', 'teams', 'score', 'scores', 'scorebook', 'official', 'officials',
  'date', 'time', 'place', 'played', 'at', 'site', 'location', 'game', 'no', 'number', 'coach', 'coaches', 'asst',
  'assistant', 'referee', 'umpire', 'scorer', 'timer', 'final', 'total', 'totals', 'half', 'quarter', 'quarters',
  'period', 'periods', 'ot', 'overtime', 'first', 'second', 'third', 'fourth', 'timeouts', 'timeout', 'time', 'outs',
  'fouls', 'foul', 'team', 'technical', 'technicals', 'bench', 'running', 'possession', 'arrow', 'field', 'goals',
  'free', 'throws', 'throw', 'points', 'pts', 'fg', 'ft', 'tp', 'player', 'players', 'name', 'names', 'starters',
  'in', 'out', 'and', 'of', 'the', 'vs', 'versus', 'by', 'for', 'per', 'event', 'heat', 'lane', 'round', 'meet',
  'athlete', 'school', 'mark', 'result', 'results', 'wind', 'seed', 'bib', 'division', 'flight', 'attempt', 'attempts',
  'best', 'height', 'distance', 'jump', 'throws', 'relay', 'split', 'splits', 'place', 'pl', 'boys', 'girls', 'mens',
  'womens', 'varsity', 'jv', 'signature', 'remarks', 'notes', 'league', 'conference', 'tournament',
];

const words = new Set<string>(GENERIC);
for (const c of Object.values(CATALOGS)) {
  for (const p of c.parts) {
    for (const l of p.labels) words.add(l.toLowerCase().replace(/[^a-z0-9]/g, ''));
    for (const w of p.name.toLowerCase().split(/[^a-z0-9]+/)) if (w) words.add(w);
  }
}
for (const layout of LIBRARY) for (const a of layout.anchors) if (/^[a-z]+$/.test(a.text)) words.add(a.text);
words.delete('');

/** True when the text is vocabulary words run together (anchors join a whole line's letters). */
export function isPrintedVocabulary(text: string): boolean {
  if (/^\d(st|nd|rd|th)$/.test(text) || /^\d{1,2}$/.test(text)) return true;
  if (!/^[a-z]+$/.test(text) || text.length > 60) return false;
  const ok: boolean[] = new Array(text.length + 1).fill(false);
  ok[0] = true;
  for (let i = 1; i <= text.length; i++) {
    for (let j = Math.max(0, i - 16); j < i && !ok[i]; j++) if (ok[j] && words.has(text.slice(j, i))) ok[i] = true;
  }
  return ok[text.length];
}

/** Words a template's name may use besides printed vocabulary: scorebook makers and plain description. */
const NAME_WORDS = new Set<string>([
  'book', 'books', 'sheet', 'sheets', 'scoresheet', 'scoresheets', 'form', 'forms', 'short', 'long', 'full', 'size', 'page',
  'pages', 'spiral', 'edition', 'version', 'new', 'old', 'my', 'our', 'copy', 'rec', 'recreation', 'youth', 'middle',
  'high', 'jv', 'varsity', 'freshman', 'travel', 'aau', 'nfhs', 'ymca', 'glover', 'glovers', 'champion', 'markwort',
  'mark', 'murray', 'hardwood', 'vanguard', 'right', 'it', 'style', 'standard', 'basic', 'simple', 'blue', 'red', 'green',
  'white', 'black', 'yellow', 'orange', 'gold', 'purple', 'one', 'two', 'both', 'per', 'layout', 'template', 'stats',
]);
for (const layout of LIBRARY) {
  for (const w of `${layout.name} ${layout.family}`.toLowerCase().split(/[^a-z0-9]+/)) if (w) NAME_WORDS.add(w);
}

/**
 * The name a shared template goes out under. Scorekeepers name templates freely, and a
 * name can hold a person ("Jordan's book"), often a minor's. Shared templates show in
 * browse to anyone signed in, so a name is kept only when every word is scoresheet
 * vocabulary, a scorebook maker, a plain describing word or a number; otherwise it
 * becomes the built-in book's name, or a generic one.
 */
export function safeTemplateName(name: string, builtinId?: string | null): string {
  const words = name.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  const ok = words.length > 0 && words.every((w) => /^\d+$/.test(w) || NAME_WORDS.has(w) || isPrintedVocabulary(w));
  if (ok) return name.trim().replace(/\s+/g, ' ').slice(0, 80);
  return LIBRARY.find((l) => l.id === builtinId)?.name ?? 'Shared scoresheet';
}

// The app's own range: a box may hang a little off the page edge.
const unit = z.number().min(-0.5).max(1.5);
const box = z.object({ x: unit, y: unit, w: unit, h: unit });
const band = z.object({ x: unit, w: unit, lean: z.number().min(-0.5).max(0.5).optional() });

/** Whether a page holds one team or both, and where home is. */
export const sheetSchema = z.object({
  teams: z.enum(['one', 'both']),
  homeAt: z.enum(['top', 'bottom', 'left', 'right']).optional(),
});

/** Most anchors a shared layout keeps (after the vocabulary filter). */
const MAX_SHARED_ANCHORS = 400;

/**
 * What a publish may send: a layout, or the app's whole stored template (version,
 * photoUri, test and timestamps are ignored). `id` is the app's own template id, so
 * publishing the same template again updates it instead of adding another.
 */
export const layoutSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  sport: z.enum(SPORTS as [Sport, ...Sport[]]),
  name: z.string().trim().min(1).max(120),
  enabled: z.array(z.string().max(40)).max(80),
  parts: z.record(z.string().max(40), z.union([box, band])),
  variants: z.record(z.string().max(40), z.string().max(40)).default({}),
  anchors: z.array(z.object({ text: z.string().max(120), x: unit, y: unit })).max(2000).optional(),
  builtinId: z.string().max(80).optional(),
  sheet: sheetSchema.optional(),
});

/** A shared layout as stored: never a photo, never the app's id, anchors only as printed words. */
export interface SharedLayout {
  sport: Sport;
  name: string;
  enabled: string[];
  parts: Record<string, z.infer<typeof box> | z.infer<typeof band>>;
  variants: Record<string, string>;
  anchors?: { text: string; x: number; y: number }[];
  builtinId?: string;
  sheet?: z.infer<typeof sheetSchema>;
}

/**
 * Drops unknown parts and every anchor that is not printed vocabulary; refuses a layout
 * with nothing left. Every path that shares a template outside its owner goes through here.
 */
export function sanitizeLayout(input: unknown): { layout: SharedLayout; droppedAnchors: number; sourceId: string | null } {
  const parsed = layoutSchema.safeParse(input);
  if (!parsed.success) {
    throw ApiError.badRequest('InvalidTemplate', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const l = parsed.data;
  const known = new Set<string>(CATALOGS[l.sport].parts.map((p) => p.id));
  const parts = Object.fromEntries(Object.entries(l.parts).filter(([id]) => known.has(id)));
  if (!Object.keys(parts).length) throw ApiError.badRequest('InvalidTemplate', 'The template has no marked parts.');
  const anchors = (l.anchors ?? [])
    .filter((a) => isPrintedVocabulary(a.text))
    .slice(0, MAX_SHARED_ANCHORS)
    .map((a) => ({ text: a.text, x: a.x, y: a.y }));
  return {
    layout: {
      sport: l.sport,
      name: safeTemplateName(l.name, l.builtinId),
      enabled: l.enabled.filter((id) => known.has(id)),
      parts,
      variants: Object.fromEntries(Object.entries(l.variants).filter(([id]) => known.has(id))),
      ...(anchors.length ? { anchors } : {}),
      ...(l.builtinId ? { builtinId: l.builtinId } : {}),
      ...(l.sheet ? { sheet: { teams: l.sheet.teams, ...(l.sheet.homeAt ? { homeAt: l.sheet.homeAt } : {}) } } : {}),
    },
    droppedAnchors: (l.anchors?.length ?? 0) - anchors.length,
    sourceId: l.id ?? null,
  };
}
