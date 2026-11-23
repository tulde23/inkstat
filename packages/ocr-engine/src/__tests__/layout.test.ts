import { columnSlice, stripCount, tileRects } from '../geometry';
import { withRegionOverrides } from '../pipeline';
import type { DocumentTemplate, RegionSpec } from '../types';

const region = (over: Partial<RegionSpec> = {}): RegionSpec => ({
  id: 'rows',
  label: 'Rows',
  rect: { x: 0.1, y: 0.4, w: 0.8, h: 0.5 },
  prompt: 'p',
  schema: { type: 'object', properties: {} },
  ...over,
});

describe('stripCount', () => {
  it('uses a fixed row count as given', () => {
    expect(stripCount(region({ tiles: { rows: 5, overlap: 0 } }), 1000, 1000, false)).toBe(5);
  });

  it('picks enough strips for near-square crops of the joined columns', () => {
    // Joined width = 0.2 + 0.1 of a 2000px page = 600px; region is 0.5 * 1400 = 700px tall.
    const r = region({
      tiles: { targetAspect: 1, overlap: 0.1 },
      columns: [
        { x: 0.1, w: 0.2, label: 'a' },
        { x: 0.8, w: 0.1, label: 'b' },
      ],
      joinColumns: true,
    });
    expect(stripCount(r, 2000, 1400, true)).toBe(1); // 700 / 600 rounds to 1
    expect(stripCount({ ...r, rect: { ...r.rect, h: 0.8 } }, 2000, 3000, true)).toBe(4); // 2400 / 600
  });

  it('uses the full width when columns are not joined, and respects min/max', () => {
    const r = region({ tiles: { targetAspect: 1, overlap: 0, minRows: 2, maxRows: 3 } });
    expect(stripCount(r, 1000, 1000, false)).toBe(2); // 500 / 800 rounds to 1, raised to min 2
    expect(stripCount({ ...r, rect: { ...r.rect, w: 0.05 } }, 1000, 1000, false)).toBe(3); // capped at max
  });

  it('feeds tileRects', () => {
    expect(tileRects(region().rect, { targetAspect: 1, overlap: 0 }, 4)).toHaveLength(4);
  });
});

describe('withRegionOverrides', () => {
  it('replaces only the named region fields', () => {
    const t: DocumentTemplate = { id: 't', name: 'T', version: 1, regions: [region(), region({ id: 'other' })] };
    const out = withRegionOverrides(t, { rows: { rect: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(out.regions[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(out.regions[0].prompt).toBe('p');
    expect(out.regions[1]).toBe(t.regions[1]);
  });
});

describe('columnSlice', () => {
  const rows = { y: 0.2, h: 0.6 };
  it('is the plain column when it does not lean', () => {
    expect(columnSlice({ x: 0.5, w: 0.1 }, rows, { y: 0.2, h: 0.3 })).toEqual({ x: 0.5, y: 0.2, w: 0.1, h: 0.3 });
  });
  it('takes the stretch a leaning column crosses in each strip', () => {
    const top = columnSlice({ x: 0.5, w: 0.1, lean: 0.06 }, rows, { y: 0.2, h: 0.3 });
    const bottom = columnSlice({ x: 0.5, w: 0.1, lean: 0.06 }, rows, { y: 0.5, h: 0.3 });
    expect(top.x).toBeCloseTo(0.5);
    expect(top.w).toBeCloseTo(0.13);
    expect(bottom.x).toBeCloseTo(0.53);
    expect(bottom.w).toBeCloseTo(0.13);
  });
  it('leans left too', () => {
    const r = columnSlice({ x: 0.5, w: 0.1, lean: -0.06 }, rows, { y: 0.5, h: 0.3 });
    expect(r.x).toBeCloseTo(0.44);
    expect(r.w).toBeCloseTo(0.13);
  });
});
