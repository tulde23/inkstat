import type { NormRect, TextLine } from '@inkstat/ocr-engine';

import { recognizeSheet } from '../library';
import { anchorsForTemplate } from '../library';
import { newTemplate } from '../scorebook';
import champion from './fixtures/nfhs-champion-blank-ocr.json';
import gloverAnchors from '../library/glover-short-form.anchors.json';
import stars from './fixtures/stars-ocr.json';

const moved = (lines: TextLine[], sx: number, sy: number, dx: number, dy: number): TextLine[] => {
  const r = (q: NormRect): NormRect => ({ x: q.x * sx + dx, y: q.y * sy + dy, w: q.w * sx, h: q.h * sy });
  return lines.map((l) => ({ text: l.text, rect: r(l.rect), words: l.words.map((w) => ({ text: w.text, rect: r(w.rect) })) }));
};

/** A page as OCR would see it: one line per printed label (Glover's has no committed photo OCR; it holds names). */
const fromAnchors = (anchors: { text: string; x: number; y: number }[]): TextLine[] =>
  anchors.map((a) => ({ text: a.text, rect: { x: a.x - 0.01, y: a.y - 0.005, w: 0.02, h: 0.01 }, words: [] }));

describe('recognizeSheet', () => {
  it("recognises Glover's Short Form, framed differently", () => {
    const r = recognizeSheet(moved(fromAnchors(gloverAnchors), 0.9, 0.92, 0.04, 0.03), []);
    expect(r.kind).toBe('sure');
    if (r.kind === 'sure') {
      expect(r.template.builtinId).toBe('glover-short-form');
      expect(r.spread).toBeNull();
    }
  });

  it("sees both Glover's pages in one photo as a spread, home on the left", () => {
    const page = fromAnchors(gloverAnchors);
    const r = recognizeSheet([...moved(page, 0.49, 0.9, 0.0, 0.05), ...moved(page, 0.49, 0.9, 0.51, 0.05)], []);
    expect(r.kind).toBe('sure');
    if (r.kind === 'sure') {
      expect(r.template.builtinId).toBe('glover-short-form');
      expect(r.spread).not.toBeNull();
    }
  });

  it('is sure of a built-in book, and treats it as one team per page', () => {
    const r = recognizeSheet(champion, []);
    expect(r.kind).toBe('sure');
    if (r.kind !== 'sure') return;
    expect(r.template.builtinId).toBe('nfhs-champion');
    expect(r.template.sheet).toEqual({ teams: 'one' });
    expect(r.spread).toBeNull();
  });

  it('sees a book spread: the page fills only the left half of the photo', () => {
    const r = recognizeSheet(moved(champion, 0.48, 0.95, 0.01, 0.02), []);
    expect(r.kind).toBe('sure');
    if (r.kind === 'sure') expect(r.spread).toBe('left');
  });

  it("finds the user's own template before saying the page is new", () => {
    expect(recognizeSheet(stars, []).kind).toBe('none');
    const mine = { ...newTemplate('mine', 'Stars sheet', null), anchors: anchorsForTemplate(stars), sheet: { teams: 'both' as const, homeAt: 'top' as const } };
    const r = recognizeSheet(stars, [mine]);
    expect(r.kind).toBe('sure');
    if (r.kind === 'sure') {
      expect(r.template.id).toBe('mine');
      expect(r.spread).toBeNull();
    }
  });

  it('is only partly sure when few printed labels survive (glare, a cropped photo)', () => {
    const r = recognizeSheet(champion.filter((_, i) => i % 5 === 0), []);
    expect(r.kind).toBe('partly');
    if (r.kind === 'partly') expect(r.template.builtinId).toBe('nfhs-champion');
  });

  it('blames the photo when almost no printed words were read', () => {
    const blurry: TextLine[] = [{ text: '7 12', rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, words: [] }];
    expect(recognizeSheet(blurry, []).kind).toBe('notext');
  });
});
