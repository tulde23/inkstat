import { evaluate, Missing, namesIn, parseDate, parseNumber, parseRule, parseTime, parseTimeTemp, parseValue, toCSV, toYAML, type FormData, type FormTemplate } from '../index';

describe('parsing written values', () => {
  it('reads numbers with separators, units and degrees', () => {
    expect(parseNumber('61,250')).toBe(61250);
    expect(parseNumber('12.5 psi')).toBe(12.5);
    expect(parseNumber('68°')).toBe(68);
    expect(parseNumber('.67')).toBe(0.67);
    expect(parseNumber('-3')).toBe(-3);
    expect(parseNumber('12+50')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
  it('reads US dates and times', () => {
    expect(parseDate('10/14/26')).toBe('2026-10-14');
    expect(parseDate('4/7/2026')).toBe('2026-04-07');
    expect(parseDate('2026-04-07')).toBe('2026-04-07');
    expect(parseDate('13/40/26')).toBeNull();
    expect(parseTime('9:40')).toBe('09:40');
    expect(parseTime('3:15pm')).toBe('15:15');
    expect(parseTime('12:05 am')).toBe('00:05');
    expect(parseTime('25:00')).toBeNull();
  });
  it('reads time/temperature cells', () => {
    expect(parseTimeTemp('3:20/68')).toEqual({ time: '03:20', temp: 68 });
    expect(parseTimeTemp('68 @ 2:15')).toEqual({ time: '02:15', temp: 68 });
    expect(parseTimeTemp('41')).toEqual({ time: null, temp: 41 });
  });
  it('keeps what doesn’t parse as written, and flags it', () => {
    expect(parseValue({ id: 'n', label: 'N', kind: 'number' }, 'about 7')).toEqual({ value: 'about 7', ok: false });
    expect(parseValue({ id: 'n', label: 'N', kind: 'integer' }, '7.5')).toEqual({ value: '7.5', ok: false });
    expect(parseValue({ id: 'n', label: 'N', kind: 'number' }, 'N/A')).toEqual({ value: null, ok: true });
    expect(parseValue({ id: 'c', label: 'C', kind: 'checkbox' }, 'X')).toEqual({ value: true, ok: true });
    expect(parseValue({ id: 'c', label: 'C', kind: 'choice', options: ['Pass', 'Fail'] }, 'pass')).toEqual({ value: 'Pass', ok: true });
  });
});

describe('rules', () => {
  const look = (vals: Record<string, number | null>) => (n: string) => (n in vals ? vals[n] : null);
  it('does arithmetic, functions and comparisons with rounding allowed on ==', () => {
    expect(evaluate(parseRule('D == B * C'), look({ B: 1200, C: 24, D: 28800 }))).toBe(1);
    expect(evaluate(parseRule('G == ceil(F * (D * E / 27000))'), look({ F: 4, D: 28800, E: 0.67, G: 3 }), 0)).toBe(1);
    expect(evaluate(parseRule('area == pi * (d / 2) ^ 2'), look({ area: 12.57, d: 4 }))).toBe(1);
    expect(evaluate(parseRule('area == pi * (d / 2) ^ 2'), look({ area: 13.5, d: 4 }))).toBe(0);
    expect(evaluate(parseRule('t <= 70 and t >= 0'), look({ t: 72 }))).toBe(0);
    expect(evaluate(parseRule('-x + 2 * 3 ^ 2'), look({ x: 1 }))).toBe(17);
  });
  it('lists the names it reads, and reports a missing one', () => {
    expect(namesIn(parseRule('h2.time - start.time <= 120'))).toEqual(['h2.time', 'start.time']);
    expect(() => evaluate(parseRule('a + b'), look({ a: 1 }))).toThrow(Missing);
  });
  it('refuses anything that isn’t a rule', () => {
    expect(() => parseRule('a +')).toThrow();
    expect(() => parseRule('alert(1)')).toThrow(/Unknown function/);
    expect(() => parseRule('a; b')).toThrow();
  });
});

describe('exports', () => {
  const t: FormTemplate = {
    kind: 'form',
    version: 1,
    id: 'log',
    name: 'Log',
    photoUri: null,
    createdAt: 0,
    updatedAt: 0,
    checks: [],
    fields: [{ id: 'by', label: 'By', kind: 'text', rect: null }],
    tables: [
      {
        id: 'rows',
        label: 'Rows',
        orientation: 'rows',
        rect: null,
        maxRows: 5,
        columns: [
          { id: 'food', label: 'Food', kind: 'text', band: null },
          { id: 'h2', label: '2 h', kind: 'timeTemp', band: null },
        ],
      },
    ],
  };
  const data: FormData = {
    template: { id: 'log', name: 'Log' },
    source: 'p.jpg',
    readAt: 0,
    fields: { by: 'M, R' },
    tables: { rows: [{ food: 'Chili "hot"', h2: { time: '03:20', temp: 68 } }] },
    issues: [],
  };
  it('writes CSV with quoting, split pairs and the form fields on every row', () => {
    const csv = toCSV(t, data);
    expect(csv['rows.csv'].split('\r\n')).toEqual(['row,food,h2_time,h2_temp,by', '1,"Chili ""hot""",03:20,68,"M, R"']);
    expect(csv['fields.csv']).toContain('by,By,"M, R",');
  });
  it('writes YAML that keeps strings strings', () => {
    const y = toYAML({ ...data, fields: { by: 'yes' } }, []);
    expect(y).toContain('by: "yes"');
    expect(y).toContain('  rows:\n    - food: "Chili \\"hot\\""\n      h2:\n        time: "03:20"\n        temp: 68');
  });
});
