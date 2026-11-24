import type { ExtractionRun, RegionResult } from '@inkstat/ocr-engine';

import { LIBRARY, readForm, runChecks } from '../index';

/**
 * Real answers from Gemini Nano on a Pixel, reading the cooling-log sample
 * (2026-11-24). Every reading was right, but the model ran the three food names
 * together in two narrow columns, left the names off in the 6-hour column, and
 * copied the printed "Food product" heading from an empty strip.
 */
const ANSWERS: [string, number, string][] = [
  ['field_verifiedBy', 0, '{ "value": null }'],
  ['field_verifiedDate', 0, '{ "value": "11/20/26" }'],
  ['field_correctiveActions', 0, '{ "value": "Rice 72F at 2 hrs - moved to ice bath" }'],
  ['table_cooling_date', 0, '{ "rows": [ { "_key": "Chili Rice Turkey stock", "date": "11/20/26" } ] }'],
  ['table_cooling_date', 1, '{ "rows": [ { "_key": null, "date": null } ] }'],
  ['table_cooling_start', 0, '{ "rows": [ { "_key": "Chili", "start": "1:30/135" }, { "_key": "Rice", "start": "7:00/140" }, { "_key": "Turkey stock", "start": "2:00/150" } ] }'],
  ['table_cooling_start', 1, '{ "rows": [ { "_key": "Food product", "start": null } ] }'],
  ['table_cooling_h1', 0, '{ "rows": [ { "_key": "Chili", "h1": "2:30/102" }, { "_key": "Rice", "h1": "7:55/104" }, { "_key": "Turkey stock", "h1": "2:50/110" } ] }'],
  ['table_cooling_h1', 1, '{ "rows": [ { "_key": "Food product", "h1": null } ] }'],
  ['table_cooling_h2', 0, '{ "rows": [ { "_key": "Chili", "h2": "3:20/68" }, { "_key": "Rice", "h2": "8:50/72" }, { "_key": "Turkey stock", "h2": "3:40/69" } ] }'],
  ['table_cooling_h2', 1, '{ "rows": [ { "_key": null, "h2": null }, { "_key": null, "h2": null } ] }'],
  ['table_cooling_h3', 0, '{ "rows": [ { "_key": "Chili", "h3": "4:15/56" }, { "_key": "Rice", "h3": "9:45/60" }, { "_key": "Turkey stock", "h3": "4:30/58" } ] }'],
  ['table_cooling_h4', 0, '{ "rows": [ { "_key": "Chili", "h4": "5:10/47" }, { "_key": "Rice", "h4": "10:40/50" }, { "_key": "Turkey stock", "h4": "5:20/48" } ] }'],
  ['table_cooling_h5', 0, '{ "rows": [ { "_key": "Chili", "h5": "6:05/42" }, { "_key": "Rice", "h5": "11:30/44" }, { "_key": "Turkey stock", "h5": "6:10/41" } ] }'],
  ['table_cooling_h5', 1, '{ "rows": [ { "_key": "Food product", "h5": null } ] }'],
  ['table_cooling_h6', 0, '{ "rows": [ { "_key": "Chili", "h6": null }, { "_key": "Rice", "h6": null }, { "_key": "Turkey stock", "h6": null }, { "_key": null, "h6": "7:00/39" }, { "_key": null, "h6": "12:20/40" } ] }'],
  ['table_cooling_monitoredBy', 0, '{ "rows": [ { "_key": "Chili Rice Turkey stock", "monitoredBy": "AK MR" } ] }'],
];

const result = ([regionId, tileIndex, json]: [string, number, string]): RegionResult => ({
  regionId,
  tileIndex,
  tileCount: 2,
  rect: { x: 0, y: 0, w: 1, h: 1 },
  imageUri: '',
  imageUris: [],
  data: JSON.parse(json),
  raw: json,
  warnings: [],
  attempts: 1,
  durationMs: 1,
});

const run: ExtractionRun = { templateId: 'form.mn-cooling-log', templateVersion: 1, modelId: 'gemini-nano', sourceUri: 'photo.jpg', results: ANSWERS.map(result), startedAt: 0, finishedAt: 38000 };

describe('a real Gemini Nano read of the cooling log', () => {
  const t = LIBRARY.find((x) => x.id === 'mn-cooling-log')!;
  const data = readForm(t, run, 0);
  const rows = data.tables.cooling;

  it('keeps the three foods as rows, and no printed heading or run-together names', () => {
    expect(rows.map((r) => r.food)).toEqual(['Chili', 'Rice', 'Turkey stock']);
  });

  it('puts every reading on its own food’s row', () => {
    expect(rows.map((r) => r.h2)).toEqual([
      { time: '03:20', temp: 68 },
      { time: '08:50', temp: 72 },
      { time: '03:40', temp: 69 },
    ]);
    // The 6-hour values came without names: placed top to bottom, and said so.
    expect(rows.map((r) => r.h6)).toEqual([{ time: '07:00', temp: 39 }, { time: '12:20', temp: 40 }, null]);
    expect(data.issues).toContain('Cooling log Less than 6 hours: matched to rows by position (the food product wasn’t read beside it)'.replace('’', "'"));
  });

  it('leaves run-together values out rather than guessing their row', () => {
    expect(rows.map((r) => r.date)).toEqual([null, null, null]);
    expect(data.issues.some((s) => s.includes('Date: couldn') && s.includes('11/20/26'))).toBe(true);
  });

  it('flags the rice, which was 72°F at 2 hours', () => {
    const failed = runChecks(t, data).filter((c) => c.status === 'fail');
    expect(failed.map((c) => `${c.id}#${c.row}`)).toEqual(['at70#2']);
  });
});
