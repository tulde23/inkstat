import type { NormRect } from '@inkstat/ocr-engine';

import type { BoxField, CheckDef, FieldDef, FormTemplate, TableColumn, TableRowField } from '../types';
import ridotAnchors from './ridot-tf2.anchors.json';
import laAnchors from './la-dotd-0740.anchors.json';
import mnAnchors from './mn-cooling-log.anchors.json';

/**
 * Built-in templates for public blank forms. Boxes were measured from the
 * printed lines in each PDF (fractions of the page) and anchors are its printed
 * words, so a photo of a filled-in copy is recognised and lined up without
 * marking anything. Layouts only: no filled-in data is stored here.
 */

type Opts = Partial<Omit<FieldDef, 'id' | 'label' | 'kind'>>;
const r = (x: number, y: number, w: number, h: number): NormRect => ({ x, y, w, h });
const box = (id: string, label: string, kind: FieldDef['kind'], rect: NormRect, o: Opts = {}): BoxField => ({ id, label, kind, rect, ...o });
const col = (id: string, label: string, kind: FieldDef['kind'], x: number, w: number, o: Opts = {}): TableColumn => ({ id, label, kind, band: { x, w }, ...o });
const line = (id: string, label: string, kind: FieldDef['kind'], y: number, h: number, o: Opts = {}): TableRowField => ({ id, label, kind, band: { y, h }, ...o });
const check = (id: string, label: string, rule: string, o: Partial<CheckDef> = {}): CheckDef => ({ id, label, rule, ...o });

const base = { kind: 'form' as const, version: 1 as const, photoUri: null, createdAt: 0, updatedAt: 0 };

// ── Rhode Island DOT TF2-301: Nuclear Density Test of Soils Report ──
// Letters A–R are the form's own; its formulas are printed beside the boxes.

const RIDOT_TF2: FormTemplate = {
  ...base,
  id: 'ridot-tf2',
  builtinId: 'ridot-tf2',
  name: 'Nuclear Density Test of Soils (RIDOT TF2)',
  description: 'Rhode Island DOT soil compaction report: section details A–H at the top, then up to four nuclear gauge tests side by side.',
  source: 'https://www.dot.ri.gov/documents/doingbusiness/materials/fieldforms/Field/301%20-%20TF2%20-%20Nuclear%20Density%20Test%20of%20Soils%20Report.pdf',
  anchors: ridotAnchors,
  fields: [
    box('itemNo', 'Item No', 'text', r(0.165, 0.1, 0.38, 0.02)),
    box('date', 'Date', 'date', r(0.82, 0.1, 0.13, 0.02)),
    box('contractNo', 'RI Contract No', 'text', r(0.215, 0.12, 0.155, 0.02)),
    box('ptsid', 'PTSID', 'text', r(0.43, 0.12, 0.115, 0.02)),
    box('fapNo', 'F.A.P. No', 'text', r(0.633, 0.12, 0.317, 0.02)),
    box('project', 'Project', 'text', r(0.158, 0.14, 0.387, 0.02)),
    box('location', 'Location', 'text', r(0.625, 0.14, 0.325, 0.02)),
    box('gaugeNo', 'Gauge No', 'text', r(0.182, 0.16, 0.363, 0.02)),
    box('stdDensity', 'Daily Std: Density', 'integer', r(0.706, 0.16, 0.08, 0.02), { hint: 'gauge standard count' }),
    box('stdMoisture', 'Daily Std: Moisture', 'integer', r(0.862, 0.16, 0.088, 0.02), { hint: 'gauge standard count' }),
    box('testType', 'Test type', 'choice', r(0.087, 0.19, 0.864, 0.025), { options: ['Acceptance', 'Independent', 'Info Only'] }),
    box('soil', 'Soil Description', 'text', r(0.22, 0.215, 0.322, 0.026)),
    box('labNo', 'Referenced Lab No', 'text', r(0.705, 0.215, 0.245, 0.026)),
    box('A', 'A: Theoretical Max Dry Density', 'number', r(0.41, 0.241, 0.102, 0.025), { unit: 'lbf/ft³', min: 80, max: 160 }),
    box('optMoisture', 'Opt. Moisture', 'number', r(0.839, 0.241, 0.111, 0.025), { unit: '%', min: 0, max: 40 }),
    box('sectionBegin', 'Section Begin (station)', 'text', r(0.31, 0.286, 0.2, 0.025), { hint: 'a station like 12+50' }),
    box('sectionEnd', 'Section End (station)', 'text', r(0.72, 0.286, 0.23, 0.025), { hint: 'a station like 12+50' }),
    box('B', 'B: Total Length of Section', 'number', r(0.41, 0.311, 0.102, 0.025), { unit: 'ft' }),
    box('C', 'C: Average Width of Section', 'number', r(0.839, 0.311, 0.111, 0.025), { unit: 'ft' }),
    box('D', 'D: Approx. Area of Section', 'number', r(0.41, 0.337, 0.102, 0.025), { unit: 'ft²' }),
    box('E', 'E: Approx. Lift Thickness', 'number', r(0.41, 0.362, 0.102, 0.025), { unit: 'ft' }),
    box('F', 'F: No. of Lifts Represented', 'integer', r(0.839, 0.362, 0.111, 0.025)),
    box('G', 'G: Minimum No. of tests', 'integer', r(0.41, 0.388, 0.102, 0.03)),
    box('H', 'H: Sublot Length', 'number', r(0.839, 0.388, 0.111, 0.03), { unit: 'ft' }),
    box('spec', 'Specification result', 'choice', r(0.087, 0.827, 0.864, 0.025), { options: ['Meets Spec', 'Does Not Meet Spec', 'Info Only'] }),
    box('remarks', 'Remarks', 'text', r(0.087, 0.852, 0.864, 0.045)),
    box('technician', 'Technician', 'text', r(0.088, 0.895, 0.31, 0.03)),
  ],
  tables: [
    {
      id: 'tests',
      label: 'Test Number',
      orientation: 'columns',
      rect: r(0.087, 0.446, 0.864, 0.381),
      cells: { x: 0.407, w: 0.537 },
      records: 4,
      fields: [
        line('I', 'I: Sublot Begin (station)', 'text', 0.446, 0.025, { hint: 'a station like 12+50' }),
        line('J', 'J: Random #1', 'number', 0.471, 0.026, { min: 0.0001, max: 1 }),
        line('K', 'K: Random Length', 'number', 0.497, 0.025, { unit: 'ft' }),
        line('L', 'L: Random Station', 'text', 0.522, 0.026, { hint: 'a station like 12+50' }),
        line('M', 'M: Width @ Location L', 'number', 0.548, 0.025, { unit: 'ft' }),
        line('N', 'N: Random #2', 'number', 0.573, 0.025, { min: 0.0001, max: 1 }),
        line('P', 'P: Random Offset', 'number', 0.598, 0.026, { unit: 'ft' }),
        line('offset', 'Offset: feet Rt. / Lt. of Center', 'text', 0.624, 0.025, { hint: 'feet and Rt or Lt, like 6 Rt' }),
        line('elevation', 'Elevation', 'number', 0.649, 0.026),
        line('probeDepth', 'Probe Depth', 'number', 0.675, 0.025, { unit: 'in', min: 2, max: 12 }),
        line('moisture', 'Field Moisture Content', 'number', 0.7, 0.026, { unit: '%', min: 0, max: 40 }),
        line('wetDensity', 'Field Nuclear Wet Density', 'number', 0.726, 0.025, { unit: 'lbf/ft³', min: 80, max: 170 }),
        line('Q', 'Q: Field Nuclear Dry Density', 'number', 0.751, 0.026, { unit: 'lbf/ft³', min: 70, max: 160 }),
        line('R', 'R: % Theoretical Max Dry Density', 'number', 0.777, 0.025, { unit: '%', min: 50, max: 120 }),
        line('specification', 'Specification', 'number', 0.802, 0.025, { unit: '%', hint: 'the required minimum percent, like 95' }),
      ],
    },
  ],
  checks: [
    check('area', 'D = B × C', 'D == B * C'),
    check('minTests', 'G = F × (D × E / 27000), rounded up', 'G == ceil(F * (D * E / 27000))', { tolerance: 0 }),
    check('sublot', 'H = B / G', 'H == B / G'),
    check('randomLength', 'K = H × J', 'K == H * J', { table: 'tests' }),
    check('randomOffset', 'P = N × M', 'P == N * M', { table: 'tests' }),
    check('dryFromWet', 'Dry density = wet / (1 + moisture)', 'Q == wetDensity / (1 + moisture / 100)', { table: 'tests' }),
    check('percent', 'R = (Q / A) × 100', 'R == Q / A * 100', { table: 'tests', tolerance: 0.6 }),
    check('meetsSpec', 'R meets the specification', 'R >= specification', { table: 'tests' }),
  ],
};

// ── Louisiana DOTD 03-22-0740: Structural Concrete Tests ──
// Two batches per sheet, three cylinders each.

const batchFields = (n: 1 | 2, dy: number): BoxField[] => [
  box(`batch${n}No`, `Batch ${n}: Batch Number`, 'text', r(0.14, 0.287 + dy, 0.24, 0.022)),
  box(`batch${n}DateTested`, `Batch ${n}: Date Tested`, 'date', r(0.13, 0.314 + dy, 0.2, 0.022)),
  box(`batch${n}Slump`, `Batch ${n}: Slump`, 'number', r(0.55, 0.314 + dy, 0.12, 0.022), { unit: 'in', min: 0, max: 10 }),
  box(`batch${n}Air`, `Batch ${n}: Air Content`, 'number', r(0.84, 0.314 + dy, 0.12, 0.022), { unit: '%', min: 0, max: 12 }),
  box(`batch${n}TimeMade`, `Batch ${n}: Time Made`, 'time', r(0.105, 0.465 + dy, 0.12, 0.022)),
  box(`batch${n}Avg`, `Batch ${n}: Batch Avg.`, 'number', r(0.82, 0.465 + dy, 0.14, 0.022), { unit: 'psi' }),
];

const cylinders = (n: 1 | 2, y: number) => ({
  id: `cylinders${n}`,
  label: `Batch ${n} cylinders`,
  orientation: 'rows' as const,
  rect: r(0.037, y, 0.928, 0.078),
  key: 'sampleNo',
  maxRows: 3,
  columns: [
    col('sampleNo', 'Sample No', 'text', 0.04, 0.135),
    col('labNo', 'Laboratory No.', 'text', 0.18, 0.165),
    col('condition', 'Condition Code', 'integer', 0.345, 0.085, { min: 1, max: 4 }),
    col('breakCode', 'Break Code', 'integer', 0.43, 0.072, { min: 1, max: 6 }),
    col('age', 'Age', 'integer', 0.505, 0.06, { unit: 'days', min: 1, max: 90 }),
    col('diameter', 'Diam', 'number', 0.565, 0.065, { unit: 'in', min: 2, max: 8 }),
    col('area', 'Area', 'number', 0.63, 0.07, { unit: 'in²' }),
    col('maxLoad', 'Max Load', 'number', 0.7, 0.09, { unit: 'lb' }),
    col('strength', 'Strength', 'number', 0.79, 0.105, { unit: 'psi', min: 500, max: 15000 }),
    col('notUsed', 'Not used in Avg.', 'checkbox', 0.905, 0.045),
  ],
});

const cylinderChecks = (n: 1 | 2): CheckDef[] => [
  check(`area${n}`, 'Area = π × (Diam / 2)²', 'area == pi * (diameter / 2) ^ 2', { table: `cylinders${n}` }),
  check(`strength${n}`, 'Strength = Max Load / Area', 'strength == maxLoad / area', { table: `cylinders${n}` }),
];

const LA_DOTD_0740: FormTemplate = {
  ...base,
  id: 'la-dotd-0740',
  builtinId: 'la-dotd-0740',
  name: 'Structural Concrete Tests (Louisiana DOTD 03-22-0740)',
  description: 'Concrete acceptance sheet: two batches, each with slump, air content and three cylinder breaks (load, area, strength).',
  source: 'https://dotd.la.gov/media/1b3gzfw1/form-03-22-0740-structural-concrete-test.pdf',
  anchors: laAnchors,
  fields: [
    box('projectNo', 'Project No.', 'text', r(0.13, 0.1, 0.22, 0.022)),
    box('materialCode', 'Material Code', 'text', r(0.47, 0.1, 0.2, 0.022)),
    box('lotNo', 'Lot No.', 'text', r(0.75, 0.1, 0.21, 0.022)),
    box('dateSampled', 'Date Sampled', 'date', r(0.14, 0.118, 0.21, 0.022)),
    box('submittedBy', 'Submitted By', 'text', r(0.47, 0.118, 0.2, 0.022)),
    box('quantity', 'Quantity', 'text', r(0.76, 0.118, 0.2, 0.022)),
    box('purposeCode', 'Purpose Code', 'integer', r(0.15, 0.136, 0.06, 0.022), { min: 1, max: 9 }),
    box('plantCode', 'Plant Code', 'text', r(0.66, 0.136, 0.3, 0.022)),
    box('mixDesign', 'Mix Design No.', 'text', r(0.69, 0.155, 0.27, 0.022)),
    box('dateReceived', 'Date Received (lab)', 'date', r(0.73, 0.191, 0.23, 0.022)),
    box('itemNo', 'Item No', 'text', r(0.11, 0.242, 0.85, 0.022)),
    box('madeBy', 'Cylinders Made By', 'text', r(0.17, 0.261, 0.3, 0.022)),
    box('testedForAcceptanceBy', 'Acceptance Test By', 'text', r(0.63, 0.261, 0.33, 0.022)),
    ...batchFields(1, 0),
    ...batchFields(2, 0.221),
    box('lotAvg', 'Average Strength for Lot', 'number', r(0.79, 0.746, 0.17, 0.022), { unit: 'psi' }),
    box('testedBy', 'Tested By', 'text', r(0.69, 0.765, 0.27, 0.022)),
    box('checkedBy', 'Checked By', 'text', r(0.71, 0.783, 0.25, 0.022)),
    box('pay', '% Pay', 'number', r(0.84, 0.805, 0.12, 0.022), { unit: '%', min: 0, max: 100 }),
    box('remarks', 'Remarks', 'text', r(0.052, 0.847, 0.908, 0.06)),
    box('approvedBy', 'Approved By', 'text', r(0.735, 0.905, 0.225, 0.022)),
  ],
  tables: [cylinders(1, 0.386), cylinders(2, 0.607)],
  checks: [...cylinderChecks(1), ...cylinderChecks(2)],
};

// ── Minnesota Department of Health: Cooling Log ──
// Each cell is "time/temperature". Food code: 135°F → 70°F within 2 hours, → 41°F within 6.

const at = (id: string, label: string, x: number, w: number) => col(id, label, 'timeTemp', x, w, { unit: '°F', min: -10, max: 212 });

const MN_COOLING: FormTemplate = {
  ...base,
  id: 'mn-cooling-log',
  builtinId: 'mn-cooling-log',
  name: 'Cooling Log (Minnesota Dept. of Health)',
  description: 'Restaurant cooling log: one food per row, time and temperature when cooling starts and each hour to 6 hours.',
  source: 'https://www.health.mn.gov/communities/environment/food/docs/fs/coolinglog.pdf',
  anchors: mnAnchors,
  fields: [
    box('verifiedBy', 'Verified by (PIC or manager on duty initials)', 'text', r(0.33, 0.81, 0.1, 0.035)),
    box('verifiedDate', 'Date', 'date', r(0.47, 0.81, 0.14, 0.035)),
    box('correctiveActions', 'Corrective action(s)', 'text', r(0.045, 0.85, 0.917, 0.1)),
  ],
  tables: [
    {
      id: 'cooling',
      label: 'Cooling log',
      orientation: 'rows',
      rect: r(0.046, 0.389, 0.916, 0.418),
      key: 'food',
      maxRows: 9,
      columns: [
        col('food', 'Food product', 'text', 0.046, 0.136),
        col('date', 'Date', 'date', 0.182, 0.074),
        at('start', 'Cooling started', 0.256, 0.1),
        at('h1', 'Less than 1 hour', 0.356, 0.07),
        at('h2', 'Less than 2 hours', 0.426, 0.118),
        at('h3', 'Less than 3 hours', 0.544, 0.07),
        at('h4', 'Less than 4 hours', 0.614, 0.07),
        at('h5', 'Less than 5 hours', 0.684, 0.07),
        at('h6', 'Less than 6 hours', 0.754, 0.118),
        col('monitoredBy', 'Monitored by', 'text', 0.872, 0.09),
      ],
    },
  ],
  checks: [
    check('at70', '70°F or below by 2 hours', 'h2.temp <= 70', { table: 'cooling' }),
    check('within2h', '2-hour reading within 2 hours of the start', 'h2.time - start.time <= 120 and h2.time >= start.time', { table: 'cooling' }),
    check('at41', '41°F or below by 6 hours', 'h6.temp <= 41', { table: 'cooling' }),
    check('within6h', '6-hour reading within 6 hours of the start', 'h6.time - start.time <= 360 and h6.time >= start.time', { table: 'cooling' }),
  ],
};

export const LIBRARY: FormTemplate[] = [RIDOT_TF2, LA_DOTD_0740, MN_COOLING];
