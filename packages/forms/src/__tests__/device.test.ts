import type { ExtractionRun, RegionResult } from '@inkstat/ocr-engine';

import { LIBRARY, readForm, runChecks } from '../index';

/**
 * The ways Gemini Nano went wrong reading the cooling-log sample on a Pixel
 * (2026-11-24): it ran the three food names together in a pass whose column held
 * the same value on every row, left the names off beside some readings, and
 * copied the printed "Food product" heading from an empty strip. The readings it
 * gave were all right. These answers keep those habits, in the paired passes the
 * template reads in now.
 */
const ANSWERS: [string, number, string][] = [
  ['field_verifiedBy', 0, '{ "value": null }'],
  ['field_verifiedDate', 0, '{ "value": "11/20/26" }'],
  ['field_correctiveActions', 0, '{ "value": "Rice 72F at 2 hrs - moved to ice bath" }'],
  ['table_cooling_date', 0, '{ "rows": [ { "_key": "Chili", "date": "11/20/26", "start": "1:30/135" }, { "_key": "Rice", "date": "11/20/26", "start": "7:00/140" }, { "_key": "Turkey stock", "date": "11/20/26", "start": "2:00/150" } ] }'],
  ['table_cooling_date', 1, '{ "rows": [ { "_key": "Food product", "date": null, "start": null } ] }'],
  ['table_cooling_h1', 0, '{ "rows": [ { "_key": "Chili", "h1": "2:30/102", "h2": "3:20/68" }, { "_key": "Rice", "h1": "7:55/104", "h2": "8:50/72" }, { "_key": "Turkey stock", "h1": "2:50/110", "h2": "3:40/69" } ] }'],
  ['table_cooling_h1', 1, '{ "rows": [ { "_key": null, "h1": null, "h2": null } ] }'],
  ['table_cooling_h3', 0, '{ "rows": [ { "_key": "Chili", "h3": "4:15/56", "h4": "5:10/47" }, { "_key": "Rice", "h3": "9:45/60", "h4": "10:40/50" }, { "_key": "Turkey stock", "h3": "4:30/58", "h4": "5:20/48" } ] }'],
  ['table_cooling_h5', 0, '{ "rows": [ { "_key": "Chili Rice Turkey stock", "h5": "6:05/42", "h6": null, "monitoredBy": "AK MR" }, { "_key": null, "h5": "11:30/44", "h6": "7:00/39", "monitoredBy": null }, { "_key": null, "h5": "6:10/41", "h6": "12:20/40", "monitoredBy": null } ] }'],
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

describe('a Gemini Nano read of the cooling log, with its habits', () => {
  const t = LIBRARY.find((x) => x.id === 'mn-cooling-log')!;
  const data = readForm(t, run, 0);
  const rows = data.tables.cooling;

  it('keeps the three foods as rows, and no printed heading or run-together names', () => {
    expect(rows.map((r) => r.food)).toEqual(['Chili', 'Rice', 'Turkey stock']);
  });

  it('puts every reading on its own food’s row, and a repeated date on each', () => {
    expect(rows.map((r) => r.date)).toEqual(['2026-11-20', '2026-11-20', '2026-11-20']);
    expect(rows.map((r) => r.h2)).toEqual([
      { time: '03:20', temp: 68 },
      { time: '08:50', temp: 72 },
      { time: '03:40', temp: 69 },
    ]);
  });

  it('places a full column read without names top to bottom, and says so', () => {
    expect(rows.map((r) => r.h5)).toEqual([
      { time: '06:05', temp: 42 },
      { time: '11:30', temp: 44 },
      { time: '06:10', temp: 41 },
    ]);
    expect(data.issues.some((s) => s.includes('Less than 5 hours: matched to rows by position'))).toBe(true);
  });

  it('says so when it can’t tell which row a value belongs to, rather than guessing', () => {
    expect(rows.map((r) => r.monitoredBy)).toEqual([null, null, null]);
    expect(data.issues.some((s) => s.includes('Monitored by: couldn'))).toBe(true);
  });

  it('flags the rice, which was 72°F at 2 hours', () => {
    const failed = runChecks(t, data).filter((c) => c.status === 'fail');
    expect(failed.map((c) => `${c.id}#${c.row}`)).toEqual(['at70#2']);
  });
});
