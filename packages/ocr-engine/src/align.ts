import type { NormRect, TextLine } from './types';

/**
 * Line up a known layout with a new photo of the same kind of document.
 *
 * A layout keeps "anchors": printed words (labels) and where their centres
 * were on a reference image. On a new photo, OCR finds words; matching anchor
 * text gives candidate point pairs, and a robust fit (try pairs, keep the
 * transform most anchors agree with, then refine by least squares) gives an
 * affine map from reference positions to this photo. When enough labels agree,
 * the map is refined to a full perspective (homography), so a page shot at an
 * angle, with its far edge smaller than its near edge, also lines up. Boxes
 * marked on the reference are then mapped onto the photo, so a page shot closer,
 * further, shifted, rotated or tilted still lines up.
 *
 * Coordinates are fractions of each image (0..1); the affine map absorbs the
 * difference in aspect ratio between the two images.
 */

export interface Anchor {
  /** Normalized text: lower case, letters and digits only. */
  text: string;
  x: number;
  y: number;
}

/**
 * x' = (a·x + b·y + c) / w,  y' = (d·x + e·y + f) / w,  w = g·x + h·y + 1.
 * Without g and h (or with them 0) this is a plain affine map; with them it is a
 * perspective map (homography) for a page photographed at an angle.
 */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g?: number;
  h?: number;
}

export interface LayoutMatch {
  transform: Affine;
  /** Anchors found where the transform puts them. */
  inliers: number;
  /** Anchors in the layout. */
  total: number;
  /** inliers / total, 0..1. */
  score: number;
  /** Anchors whose text was read anywhere on the photo (glare and blur hide the rest). */
  readable: number;
  /** inliers / readable: of the labels that could be read, the share that sit where this layout puts them. */
  agreement: number;
}

export const anchorText = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every word, plus every multi-word line as one item ("FIRST HALF TEAM FOULS"). */
function textItems(lines: TextLine[]): Anchor[] {
  const items: Anchor[] = [];
  for (const l of lines) {
    const words = l.words.length ? l.words : [{ text: l.text, rect: l.rect }];
    for (const w of words) items.push({ text: anchorText(w.text), x: w.rect.x + w.rect.w / 2, y: w.rect.y + w.rect.h / 2 });
    if (words.length > 1) items.push({ text: anchorText(l.text), x: l.rect.x + l.rect.w / 2, y: l.rect.y + l.rect.h / 2 });
  }
  return items;
}

/**
 * Anchors from a reference page's OCR: printed text likely to be read the same
 * way on every copy. Keeps items with letters (handwritten numbers vary per game),
 * at least 2 characters, that appear at most twice on the page (repeated cell labels
 * like P1..P5 can't say where they are). Whole lines count as items too: words like
 * TEAM repeat, but "FIRST HALF TEAM FOULS" appears once and pins the bottom of a page.
 */
export function anchorsFrom(lines: TextLine[]): Anchor[] {
  const items = textItems(lines).filter((w) => w.text.length >= 2 && /[a-z]/.test(w.text));
  const count = new Map<string, number>();
  for (const w of items) count.set(w.text, (count.get(w.text) ?? 0) + 1);
  return items.filter((w) => (count.get(w.text) ?? 0) <= 2);
}

export const applyAffine = (t: Affine, x: number, y: number) => {
  const w = (t.g ?? 0) * x + (t.h ?? 0) * y + 1;
  return { x: (t.a * x + t.b * y + t.c) / w, y: (t.d * x + t.e * y + t.f) / w };
};

/** True when the map has perspective terms (the page was shot at an angle). */
export const isPerspective = (t: Affine) => Math.abs(t.g ?? 0) > 1e-9 || Math.abs(t.h ?? 0) > 1e-9;

/** Map a rectangle; the result is the bounding box of its four mapped corners. */
export function mapRect(t: Affine, r: NormRect): NormRect {
  const pts = [
    applyAffine(t, r.x, r.y),
    applyAffine(t, r.x + r.w, r.y),
    applyAffine(t, r.x, r.y + r.h),
    applyAffine(t, r.x + r.w, r.y + r.h),
  ];
  const x0 = Math.min(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  return { x: x0, y: y0, w: Math.max(...pts.map((p) => p.x)) - x0, h: Math.max(...pts.map((p) => p.y)) - y0 };
}

export type Pair = { ax: number; ay: number; px: number; py: number };

/** Levenshtein distance, giving up (returning max + 1) once it must exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Least-squares affine from point pairs (needs 3+ pairs not all on one line). */
function fitAffine(pairs: Pair[]): Affine | null {
  // Normal equations for [x y 1]·[a b c]ᵀ = x' (and likewise for y').
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0;
  let tx = 0, txx = 0, txy = 0, ty = 0, tyx = 0, tyy = 0;
  for (const p of pairs) {
    sxx += p.ax * p.ax; sxy += p.ax * p.ay; sx += p.ax; syy += p.ay * p.ay; sy += p.ay; n++;
    txx += p.ax * p.px; txy += p.ay * p.px; tx += p.px;
    tyx += p.ax * p.py; tyy += p.ay * p.py; ty += p.py;
  }
  const M = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const solve = (rhs: number[]): number[] | null => {
    // Cramer's rule on the 3x3 system.
    const det = (m: number[][]) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-12) return null;
    return [0, 1, 2].map((col) => det(M.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)))) / D);
  };
  const r1 = solve([txx, txy, tx]);
  const r2 = solve([tyx, tyy, ty]);
  if (!r1 || !r2) return null;
  return { a: r1[0], b: r1[1], c: r1[2], d: r2[0], e: r2[1], f: r2[2] };
}

/** Solves A·x = b by Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f) for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Least-squares perspective map (homography with h33 = 1) from 8+ point pairs.
 * Each pair gives two equations linear in a..h:
 *   a·x + b·y + c − g·x·x' − h·y·x' = x'
 *   d·x + e·y + f − g·x·y' − h·y·y' = y'
 * Returns null when the pairs do not pin it down or the result is not a plausible
 * photo of a flat page (it must keep the page the right way round and not blow up).
 */
export function fitPerspective(pairs: Pair[]): Affine | null {
  if (pairs.length < 8) return null;
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (const p of pairs) {
    add([p.ax, p.ay, 1, 0, 0, 0, -p.ax * p.px, -p.ay * p.px], p.px);
    add([0, 0, 0, p.ax, p.ay, 1, -p.ax * p.py, -p.ay * p.py], p.py);
  }
  const v = solveLinear(AtA, Atb);
  if (!v || v.some((x) => !Number.isFinite(x))) return null;
  const t: Affine = { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5], g: v[6], h: v[7] };
  // A tilted photo of a page changes scale across it, but not wildly: keep the
  // divisor positive and within 0.5..2 over the whole reference page.
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const w = t.g! * x + t.h! * y + 1;
    if (w < 0.5 || w > 2) return null;
  }
  // The page must not be mirrored: the corners keep their winding order.
  const q = [applyAffine(t, 0, 0), applyAffine(t, 1, 0), applyAffine(t, 1, 1), applyAffine(t, 0, 1)];
  for (let i = 0; i < 4; i++) {
    const [o, p1, p2] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]];
    if ((p1.x - o.x) * (p2.y - p1.y) - (p1.y - o.y) * (p2.x - p1.x) <= 0) return null;
  }
  return t;
}

/** How far apart the points are in each direction (a perspective fit needs spread). */
function spread(pairs: Pair[]) {
  const xs = pairs.map((p) => p.ax);
  const ys = pairs.map((p) => p.ay);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Mean distance between where the map puts each anchor and where it was read. */
function meanError(t: Affine, pairs: Pair[]) {
  let sum = 0;
  for (const p of pairs) {
    const m = applyAffine(t, p.ax, p.ay);
    sum += Math.hypot(m.x - p.px, m.y - p.py);
  }
  return sum / Math.max(1, pairs.length);
}

/** Scale + shift (no rotation) from two pairs spread apart in both directions. */
function fitTwo(p: Pair, q: Pair): Affine | null {
  const dx = q.ax - p.ax;
  const dy = q.ay - p.ay;
  if (Math.abs(dx) < 0.15 || Math.abs(dy) < 0.15) return null;
  const sx = (q.px - p.px) / dx;
  const sy = (q.py - p.py) / dy;
  // A photo of the same page: scale stays positive and within reason.
  if (sx < 0.3 || sx > 3 || sy < 0.3 || sy > 3) return null;
  return { a: sx, b: 0, c: p.px - sx * p.ax, d: 0, e: sy, f: p.py - sy * p.ay };
}

/**
 * Find where a layout's anchors are on a photo. Returns null when too few
 * anchors agree (the photo is probably a different kind of page).
 */
export function matchLayout(anchors: Anchor[], lines: TextLine[], tolerance = 0.02): LayoutMatch | null {
  const photo = textItems(lines);
  const byText = new Map<string, { x: number; y: number }[]>();
  for (const w of photo) {
    if (!byText.has(w.text)) byText.set(w.text, []);
    byText.get(w.text)!.push(w);
  }
  // Candidate pairs: an anchor and a photo item with the same text, or, for longer
  // labels, nearly the same (OCR reads "SECOND HALE TEAM FOULS", "ARST HALF").
  const candidates: (Pair & { anchor: number })[] = [];
  const texts = [...byText.keys()];
  anchors.forEach((a, i) => {
    const allowed = a.text.length >= 12 ? 2 : a.text.length >= 6 ? 1 : 0;
    const matches = allowed
      ? texts.filter((t) => Math.abs(t.length - a.text.length) <= allowed && editDistance(t, a.text, allowed) <= allowed)
      : byText.has(a.text) ? [a.text] : [];
    for (const t of matches) for (const p of byText.get(t)!) candidates.push({ anchor: i, ax: a.x, ay: a.y, px: p.x, py: p.y });
  });
  if (candidates.length < 3) return null;

  const inliersOf = (t: Affine) => {
    // One match per anchor: the closest candidate within tolerance.
    const best = new Map<number, Pair & { err: number }>();
    for (const c of candidates) {
      const m = applyAffine(t, c.ax, c.ay);
      const err = Math.hypot(m.x - c.px, m.y - c.py);
      if (err > tolerance) continue;
      const prev = best.get(c.anchor);
      if (!prev || err < prev.err) best.set(c.anchor, { ...c, err });
    }
    return [...best.values()];
  };

  // Try transforms from pairs of candidates; keep the one most anchors agree with.
  // Deterministic: every pair when small, a fixed stride sample when large.
  let bestT: Affine | null = null;
  let bestIn: Pair[] = [];
  const N = candidates.length;
  const step = Math.max(1, Math.floor((N * N) / 40000));
  let k = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (k++ % step) continue;
      if (candidates[i].anchor === candidates[j].anchor) continue;
      const t = fitTwo(candidates[i], candidates[j]);
      if (!t) continue;
      const ins = inliersOf(t);
      if (ins.length > bestIn.length) {
        bestIn = ins;
        bestT = t;
      }
    }
  }
  if (!bestT || bestIn.length < 4) return null;

  // Refine with a full affine fit (allows slight rotation and skew), twice.
  for (let round = 0; round < 2; round++) {
    const refined = fitAffine(bestIn);
    if (!refined) break;
    const ins = inliersOf(refined);
    if (ins.length < bestIn.length) break;
    bestT = refined;
    bestIn = ins;
  }

  // Then a perspective fit, for a page shot at an angle. Only with enough labels
  // spread across the page, and only kept when at least as many labels agree and
  // they sit closer to where they were read.
  if (bestIn.length >= 8 && spread(bestIn) >= 0.3) {
    let pIn = bestIn;
    let pT: Affine | null = null;
    for (let round = 0; round < 2; round++) {
      const fit = fitPerspective(pIn);
      if (!fit) break;
      const ins = inliersOf(fit);
      if (ins.length < pIn.length) break;
      pT = fit;
      pIn = ins;
    }
    if (pT && pIn.length >= bestIn.length && meanError(pT, pIn) < meanError(bestT, bestIn)) {
      bestT = pT;
      bestIn = pIn;
    }
  }
  const readable = new Set(candidates.map((c) => c.anchor)).size;
  return {
    transform: bestT,
    inliers: bestIn.length,
    total: anchors.length,
    score: bestIn.length / Math.max(1, anchors.length),
    readable,
    agreement: bestIn.length / Math.max(1, readable),
  };
}
