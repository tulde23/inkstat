import { runTemplate } from '@inkstat/ocr-engine';

import { defsOf, documentFor, LIBRARY, parseValue, readForm, runChecks, templateForPhoto, toCSV, toJSON, toYAML, type FormTemplate, type Value } from '../index';
import { oracle, pageImages, photograph, printedLines, tilt, writeTruth, type Written } from '../testing/oracle';
import { TRUTHS } from '../testing/truths';

/**
 * End to end on simulated photos of the built-in forms filled in with made-up
 * values: recognise and line up the template, run the real pipeline (strips,
 * column slices, joining) with a reader that sees only what each crop holds,
 * put the answers together, check and export. Every written value must come
 * back, and only the planted problems may fail a check.
 */

const expected = (t: FormTemplate, id: string, raw: string | boolean): Value => {
  const defs = [...t.fields, ...t.tables.flatMap(defsOf)];
  return parseValue(defs.find((d) => d.id === id)!, raw).value;
};

// A phone photo: a little turned, shifted and further away than the reference.
const PHOTO = tilt(1.5, 0.015, -0.01, 0.95);

async function readSimulated(t: FormTemplate, misread?: (w: Written) => string | boolean, photo = PHOTO) {
  const page = photograph(writeTruth(t, TRUTHS[t.id]), photo);
  const { template, aligned } = templateForPhoto(t, printedLines(t, photo));
  const run = await runTemplate(oracle(page, t, misread), pageImages, 'photo.jpg', documentFor(template));
  const data = readForm(template, run, Date.UTC(2026, 10, 24));
  return { aligned, data, checks: runChecks(template, data) };
}

describe.each(LIBRARY.map((t) => [t.id, t] as [string, FormTemplate]))('reading a simulated photo of %s', (id, t) => {
  const truth = TRUTHS[id];

  it.each([
    ['turned 1.5°', PHOTO],
    ['turned 3° the other way, further away', tilt(-3, -0.02, 0.02, 0.88)],
    ['straight on', tilt(0)],
  ])('lines the template up and reads back every written value (%s)', async (_name, photo) => {
    const { aligned, data } = await readSimulated(t, undefined, photo);
    expect(aligned).toBe(true);
    expect(data.issues).toEqual([]);
    for (const [f, v] of Object.entries(truth.fields)) expect([f, data.fields[f]]).toEqual([f, expected(t, f, v)]);
    for (const [table, rows] of Object.entries(truth.tables)) {
      expect([table, data.tables[table].length]).toEqual([table, rows.length]);
      rows.forEach((row, i) => {
        for (const [c, v] of Object.entries(row)) expect([table, i + 1, c, data.tables[table][i][c]]).toEqual([table, i + 1, c, expected(t, c, v)]);
      });
    }
  });

  it('passes its checks except the problems planted on the paper', async () => {
    const { checks } = await readSimulated(t);
    const failed = checks.filter((c) => c.status === 'fail').map((c) => `${c.id}${c.row ? `#${c.row}` : ''}`);
    const planned: Record<string, string[]> = {
      'ridot-tf2': ['meetsSpec#3'],
      'la-dotd-0740': [],
      'mn-cooling-log': ['at70#2'],
    };
    expect(failed.sort()).toEqual(planned[id].sort());
    expect(checks.filter((c) => c.status === 'pass').length).toBeGreaterThan(5);
  });

  it('exports JSON, CSV and YAML', async () => {
    const { data, checks } = await readSimulated(t);
    const json = JSON.parse(toJSON(data, checks));
    expect(json.template).toBe(id);
    const csv = toCSV(t, data);
    for (const table of t.tables) expect(csv[`${table.id}.csv`].split('\r\n').length).toBe(1 + (truth.tables[table.id]?.length ?? 0));
    expect(toYAML(data, checks)).toContain(`template: ${id}`);

    // FORMS_SAMPLES=<dir> writes the outputs, to look at them.
    const dir = process.env.FORMS_SAMPLES;
    if (dir) {
      const fs = require('fs');
      const path = require('path');
      const out = path.join(dir, id);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, `${id}.json`), toJSON(data, checks));
      fs.writeFileSync(path.join(out, `${id}.yaml`), toYAML(data, checks));
      for (const [name, text] of Object.entries(csv)) fs.writeFileSync(path.join(out, name), text);
      fs.writeFileSync(path.join(out, 'template.json'), JSON.stringify(t, null, 2));
      fs.writeFileSync(path.join(out, 'truth.json'), JSON.stringify(truth, null, 2));
    }
  });
});

describe('a misread on a simulated photo', () => {
  it('is caught by the form’s own arithmetic (concrete strength 4873 read as 4373)', async () => {
    const t = LIBRARY.find((x) => x.id === 'la-dotd-0740')!;
    const { checks } = await readSimulated(t, (w) => (w.column === 'strength' && w.text === '4873' ? '4373' : w.text));
    const failed = checks.filter((c) => c.status === 'fail');
    expect(failed.map((c) => `${c.id}#${c.row}`)).toEqual(['strength1#1']);
    expect(failed[0].detail).toContain('strength 4373');
  });

  it('is caught on a sideways table too (soil dry density 116.0 read as 161.0)', async () => {
    const t = LIBRARY.find((x) => x.id === 'ridot-tf2')!;
    const { checks } = await readSimulated(t, (w) => (w.column === 'Q' && w.text === '116.0' ? '161.0' : w.text));
    const failed = checks.filter((c) => c.status === 'fail').map((c) => `${c.id}${c.row ? `#${c.row}` : ''}`);
    expect(failed).toEqual(expect.arrayContaining(['range.Q#2', 'dryFromWet#2', 'percent#2']));
  });
});
