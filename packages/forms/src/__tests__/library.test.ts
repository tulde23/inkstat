import { LIBRARY, namesIn, parseRule, recognize, type FormTemplate } from '../index';
import { printedLines, tilt } from '../testing/oracle';

const inPage = (r: { x: number; y: number; w: number; h: number }) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001;

describe.each(LIBRARY.map((t) => [t.id, t] as [string, FormTemplate]))('built-in %s', (_id, t) => {
  it('keeps every box on the page, every column inside its table', () => {
    for (const f of t.fields) expect(f.rect && inPage(f.rect)).toBe(true);
    for (const table of t.tables) {
      expect(table.rect && inPage(table.rect)).toBe(true);
      const rect = table.rect!;
      if (table.orientation === 'rows') {
        for (const c of table.columns) {
          expect(c.band!.x).toBeGreaterThanOrEqual(rect.x - 0.002);
          expect(c.band!.x + c.band!.w).toBeLessThanOrEqual(rect.x + rect.w + 0.002);
        }
      } else {
        expect(table.cells.x).toBeGreaterThan(rect.x);
        for (const f of table.fields) {
          expect(f.band!.y).toBeGreaterThanOrEqual(rect.y - 0.002);
          expect(f.band!.y + f.band!.h).toBeLessThanOrEqual(rect.y + rect.h + 0.002);
        }
      }
    }
  });

  it('uses each id once, and every check reads values the form has', () => {
    const fieldIds = t.fields.map((f) => f.id);
    expect(new Set(fieldIds).size).toBe(fieldIds.length);
    for (const c of t.checks) {
      const table = t.tables.find((x) => x.id === c.table);
      const defs = [...(table ? (table.orientation === 'rows' ? table.columns : table.fields) : []), ...t.fields];
      for (const name of namesIn(parseRule(c.rule))) {
        const [id, part] = name.split('.');
        const def = defs.find((d) => d.id === id);
        expect([c.id, name, !!def]).toEqual([c.id, name, true]);
        if (part) expect([name, def!.kind]).toEqual([name, 'timeTemp']);
      }
    }
  });

  it('is recognised from its printed labels, even turned and shifted, and not confused with the others', () => {
    expect(t.anchors!.length).toBeGreaterThan(40);
    const m = recognize(printedLines(t, tilt(2.5, 0.02, -0.015, 0.94)), LIBRARY);
    expect(m?.template.id).toBe(t.id);
    expect(m!.match.score).toBeGreaterThan(0.8);
  });
});
