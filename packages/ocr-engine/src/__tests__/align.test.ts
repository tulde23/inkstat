import { anchorsFrom, applyAffine, fitPerspective, isPerspective, mapRect, matchLayout } from '../align';
import type { Affine } from '../align';
import type { TextLine } from '../types';
// Real ML Kit OCR of a scoresheet, as returned on a Pixel 10 Pro.
import stars from './stars-ocr.json';

/** The same page photographed differently: smaller, shifted, rotated ~2°. */
function rephotograph(lines: TextLine[], s: number, dx: number, dy: number, deg: number): TextLine[] {
  const r = (deg * Math.PI) / 180;
  const move = (x: number, y: number) => ({
    x: s * (Math.cos(r) * (x - 0.5) - Math.sin(r) * (y - 0.5)) + 0.5 + dx,
    y: s * (Math.sin(r) * (x - 0.5) + Math.cos(r) * (y - 0.5)) + 0.5 + dy,
  });
  const rect = (q: { x: number; y: number; w: number; h: number }) => {
    const c = move(q.x + q.w / 2, q.y + q.h / 2);
    return { x: c.x - (q.w * s) / 2, y: c.y - (q.h * s) / 2, w: q.w * s, h: q.h * s };
  };
  return lines.map((l) => ({ text: l.text, rect: rect(l.rect), words: l.words.map((w) => ({ text: w.text, rect: rect(w.rect) })) }));
}

/** The same page shot at an angle: a known perspective map applied to every word. */
const TILT: Affine = { a: 0.82, b: 0.06, c: 0.05, d: -0.02, e: 0.8, f: 0.08, g: 0.18, h: 0.12 };
function tilt(lines: TextLine[]): TextLine[] {
  const rect = (q: { x: number; y: number; w: number; h: number }) => {
    const c = applyAffine(TILT, q.x + q.w / 2, q.y + q.h / 2);
    return { x: c.x - (q.w * 0.75) / 2, y: c.y - (q.h * 0.75) / 2, w: q.w * 0.75, h: q.h * 0.75 };
  };
  return lines.map((l) => ({ text: l.text, rect: rect(l.rect), words: l.words.map((w) => ({ text: w.text, rect: rect(w.rect) })) }));
}

describe('fitPerspective', () => {
  it('recovers a known perspective map from point pairs', () => {
    const pts = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5], [0.3, 0.7], [0.7, 0.2], [0.2, 0.4], [0.8, 0.6]];
    const pairs = pts.map(([x, y]) => {
      const p = applyAffine(TILT, x, y);
      return { ax: x, ay: y, px: p.x, py: p.y };
    });
    const t = fitPerspective(pairs)!;
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const) expect(t[k]).toBeCloseTo(TILT[k]!, 6);
  });

  it('needs 8 pairs and refuses a mirrored page', () => {
    expect(fitPerspective([{ ax: 0, ay: 0, px: 0, py: 0 }])).toBeNull();
    const pts = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5], [0.3, 0.7], [0.7, 0.2], [0.2, 0.4]];
    expect(fitPerspective(pts.map(([x, y]) => ({ ax: x, ay: y, px: 1 - x, py: y })))).toBeNull();
  });
});

describe('matchLayout', () => {
  const anchors = anchorsFrom(stars);

  it('keeps printed words that say where they are, not repeated cell labels', () => {
    const texts = anchors.map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining(['team', 'player', 'fouls', 'final']));
    expect(texts).not.toContain('p1');
    expect(anchors.length).toBeGreaterThan(20);
  });

  it('finds the identity on the same page', () => {
    const m = matchLayout(anchors, stars)!;
    expect(m.score).toBeGreaterThan(0.9);
    const p = applyAffine(m.transform, 0.3, 0.6);
    expect(p.x).toBeCloseTo(0.3, 2);
    expect(p.y).toBeCloseTo(0.6, 2);
  });

  it('recovers a page shot smaller, shifted and slightly rotated', () => {
    const photo = rephotograph(stars, 0.85, 0.03, -0.02, 2);
    const m = matchLayout(anchors, photo)!;
    expect(m.score).toBeGreaterThan(0.7);
    // The TP column on the reference, mapped onto the new photo.
    const tp = mapRect(m.transform, { x: 0.812, y: 0.406, w: 0.025, h: 0.5 });
    const expectedCentre = rephotograph([{ text: 'x', rect: { x: 0.8245, y: 0.656, w: 0, h: 0 }, words: [] }], 0.85, 0.03, -0.02, 2)[0].rect;
    expect(tp.x + tp.w / 2).toBeCloseTo(expectedCentre.x, 2);
    expect(tp.y + tp.h / 2).toBeCloseTo(expectedCentre.y, 2);
  });

  it('does not match a page with different words', () => {
    const other: TextLine[] = [
      { text: 'Hello world', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 }, words: [] },
      { text: 'Quarterly report', rect: { x: 0.5, y: 0.6, w: 0.2, h: 0.02 }, words: [] },
    ];
    expect(matchLayout(anchors, other)).toBeNull();
  });

  it('lines up a page shot at an angle, where an affine map cannot', () => {
    const photo = tilt(stars);
    const m = matchLayout(anchors, photo)!;
    expect(isPerspective(m.transform)).toBe(true);
    expect(m.score).toBeGreaterThan(0.8);
    // Corners of the TP column land where the tilt puts them, not just its centre.
    for (const [x, y] of [[0.812, 0.406], [0.837, 0.906]]) {
      const got = applyAffine(m.transform, x, y);
      const want = applyAffine(TILT, x, y);
      expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(0.004);
    }
  });

  it('stays affine on a flat, straight-on photo', () => {
    const m = matchLayout(anchors, stars)!;
    const p = applyAffine(m.transform, 0.9, 0.9);
    expect(p.x).toBeCloseTo(0.9, 2);
    expect(p.y).toBeCloseTo(0.9, 2);
  });
});
