import type { Band, NormRect, TextLine } from '@inkstat/ocr-engine';

import { LIBRARY, alignParts, matchLibrary, templateForPhoto } from '../library';
import { applyTemplate, migrateTemplate, newTemplate, normalizeTemplate } from '../scorebook';
import { SCOREBOOK_PAGE_TEMPLATE } from '../template';
import champion from './fixtures/nfhs-champion-blank-ocr.json';
import stars from './fixtures/stars-ocr.json';

/** The blank NFHS page photographed smaller and off-centre. */
const moved = (lines: TextLine[], s: number, dx: number, dy: number): TextLine[] => {
  const r = (q: NormRect): NormRect => ({ x: q.x * s + dx, y: q.y * s + dy, w: q.w * s, h: q.h * s });
  return lines.map((l) => ({ text: l.text, rect: r(l.rect), words: l.words.map((w) => ({ text: w.text, rect: r(w.rect) })) }));
};

describe('template library', () => {
  it('recognises the NFHS book and not the Stars sheet', () => {
    expect(matchLibrary(champion)?.layout.id).toBe('nfhs-champion');
    expect(matchLibrary(stars)).toBeNull();
  });

  it('moves every box onto a photo framed differently', () => {
    const photo = moved(champion, 0.8, 0.1, 0.05);
    const m = matchLibrary(photo)!;
    expect(m.layout.id).toBe('nfhs-champion');
    const parts = alignParts(LIBRARY[0].parts, m.match);
    const rows = parts.rows as NormRect;
    expect(rows.x).toBeCloseTo(0.048 * 0.8 + 0.1, 2);
    expect(rows.y).toBeCloseTo(0.392 * 0.8 + 0.05, 2);
    expect(parts.points!.x).toBeCloseTo(0.92 * 0.8 + 0.1, 2);
    expect(parts.points!.w).toBeCloseTo(0.032 * 0.8, 2);
  });
});

/** The same page, turned a little about its centre (the photo was taken crooked). */
const turned = (lines: TextLine[], deg: number): TextLine[] => {
  const a = (deg * Math.PI) / 180;
  const pt = (x: number, y: number) => ({
    x: 0.5 + (x - 0.5) * Math.cos(a) - (y - 0.5) * Math.sin(a),
    y: 0.5 + (x - 0.5) * Math.sin(a) + (y - 0.5) * Math.cos(a),
  });
  // Words are small, so moving each by its centre keeps them upright, as OCR reports them.
  const r = (q: NormRect): NormRect => {
    const c = pt(q.x + q.w / 2, q.y + q.h / 2);
    return { x: c.x - q.w / 2, y: c.y - q.h / 2, w: q.w, h: q.h };
  };
  return lines.map((l) => ({ text: l.text, rect: r(l.rect), words: l.words.map((w) => ({ text: w.text, rect: r(w.rect) })) }));
};

describe('leaning columns', () => {
  it('a column on a crooked photo leans with the page instead of widening', () => {
    const m = matchLibrary(turned(champion, 2))!;
    expect(m.layout.id).toBe('nfhs-champion');
    const parts = alignParts(LIBRARY[0].parts, m.match);
    const ref = LIBRARY[0].parts.points!;
    const rowsH = (LIBRARY[0].parts.rows as NormRect).h;
    // Turned clockwise, the left edge drifts left going down the page.
    expect((parts.points as Band).lean).toBeCloseTo(-Math.sin((2 * Math.PI) / 180) * rowsH, 2);
    expect(parts.points!.w).toBeCloseTo(ref.w, 2);
  });

  it('keeps a lean through normalizing, inside the rows box', () => {
    const t = normalizeTemplate({
      ...newTemplate('t', 'T', null),
      enabled: ['rows', 'names', 'points'],
      parts: { rows: { x: 0.1, y: 0.3, w: 0.8, h: 0.5 }, names: { x: 0.12, w: 0.2 }, points: { x: 0.8, w: 0.06, lean: 0.2 } },
    });
    const p = t.parts.points!;
    expect((p as Band).lean).toBeCloseTo(0.04);
    expect(t.parts.names).toEqual({ x: 0.12, w: 0.2 });
  });

  it('reads the leaning column through the template', () => {
    const doc = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, {
      ...newTemplate('t', 'T', null),
      enabled: ['rows', 'names', 'points'],
      parts: { rows: { x: 0.1, y: 0.3, w: 0.8, h: 0.5 }, names: { x: 0.12, w: 0.2 }, points: { x: 0.8, w: 0.06, lean: 0.03 } },
    });
    const players = doc.regions.find((r) => r.columns?.some((c) => c.label.startsWith('total points')))!;
    expect(players.columns!.find((c) => c.label.startsWith('total points'))!.lean).toBeCloseTo(0.03);
  });
});

describe('templateForPhoto', () => {
  const mine = {
    ...LIBRARY[0],
    version: 3 as const,
    sport: 'basketball',
    id: 'mine',
    name: 'Mine',
    photoUri: null,
    test: null,
    createdAt: 0,
    updatedAt: 0,
    anchors: LIBRARY[0].anchors,
  };

  it("lines up the user's template with a photo framed differently", () => {
    const r = templateForPhoto(mine, moved(champion, 0.8, 0.1, 0.05));
    expect(r.source).toBe('aligned');
    expect((r.template!.parts.rows as NormRect).x).toBeCloseTo(0.048 * 0.8 + 0.1, 2);
  });

  it('falls back to the saved boxes when the labels are not on the photo', () => {
    expect(templateForPhoto(mine, stars).source).toBe('as-saved');
    expect(templateForPhoto({ ...mine, anchors: undefined }, champion).source).toBe('as-saved');
  });

  it('recognises a built-in book when there is no template', () => {
    const r = templateForPhoto(null, champion);
    expect(r.source).toBe('library');
    expect(r.template!.builtinId).toBe('nfhs-champion');
    expect(templateForPhoto(null, stars).source).toBe('none');
  });
});

describe('template migration', () => {
  it('turns a v2 template (one foulsKind) into v3 variants', () => {
    const v2 = { version: 2, id: 'a', name: 'A', enabled: ['rows'], parts: {}, foulsKind: 'total', photoUri: null, test: null, createdAt: 0, updatedAt: 0 };
    const t = migrateTemplate(v2)!;
    expect(t.version).toBe(3);
    expect(t.variants).toEqual({ fouls: 'total' });
    expect('foulsKind' in t).toBe(false);
    expect(migrateTemplate({ version: 1 })).toBeNull();
  });

  it('leaves planned region types out of the read but keeps them in the template', () => {
    const t = { ...newTemplate('p', 'P', null, 0), enabled: ['rows', 'names', 'points', 'runningScore'] as const };
    const tpl = { ...t, enabled: [...t.enabled], parts: { rows: { x: 0, y: 0.3, w: 1, h: 0.6 }, names: { x: 0, w: 0.2 }, points: { x: 0.9, w: 0.05 }, runningScore: { x: 0, y: 0.1, w: 1, h: 0.1 } } };
    const ids = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, tpl).regions.map((r) => r.id);
    expect(ids).toContain('players');
    expect(ids.some((id) => id.includes('running'))).toBe(false);
    expect(tpl.parts.runningScore).toBeDefined();
  });
});
