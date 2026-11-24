import type { Anchor, Band, NormRect } from '@inkstat/ocr-engine';

/**
 * A form template is data, not code: what is on the page (single fields and
 * tables), where each one is, and the checks its values must pass. One reader
 * and one set of exporters work for every template.
 */

/**
 * What a value is, which decides how it is asked for and parsed:
 * - text, date, time: kept as written (dates and times also normalised when clear)
 * - number, integer: parsed, with units and thousands separators dropped
 * - checkbox: ticked or not
 * - choice: which one of `options` is ticked or circled
 * - timeTemp: a "time / temperature" pair written in one cell (food logs)
 */
export type ValueKind = 'text' | 'number' | 'integer' | 'date' | 'time' | 'checkbox' | 'choice' | 'timeTemp';

export interface FieldDef {
  /** Key in the exported data: letters, digits and underscores. */
  id: string;
  /** As printed on the form. */
  label: string;
  kind: ValueKind;
  unit?: string;
  /** For choice. */
  options?: string[];
  /** Range checks, for numbers. */
  min?: number;
  max?: number;
  /** Extra words for the model, e.g. "a station like 12+50". */
  hint?: string;
}

/** A single value somewhere on the page. */
export interface BoxField extends FieldDef {
  rect: NormRect | null;
}

/** A column of a table read row by row: only its left edge and width; it spans the table box. */
export interface TableColumn extends FieldDef {
  band: Band | null;
}

/**
 * A table where each row is one record (a cylinder, a batch of food). Read in
 * strips; each column is read beside the key column so values stay on their row.
 */
export interface RowTable {
  id: string;
  label: string;
  orientation: 'rows';
  /** The data rows only, without the printed headings. */
  rect: NormRect | null;
  columns: TableColumn[];
  /** Column that tells rows apart (sample number, food name). Without one, all columns are read together. */
  key?: string;
  /** Most rows the form has room for. */
  maxRows: number;
  /**
   * How far a row drops per unit across the page on a turned photo (0 when level).
   * Then `rect` is measured at its left edge: its top and height there.
   */
  slope?: number;
}

/** A field of a sideways table: one printed row, read across every record column. */
export interface TableRowField extends FieldDef {
  /** Top and height of this printed row. */
  band: { y: number; h: number } | null;
}

/**
 * A sideways table, where each column is one record (test 1, test 2, ...) and
 * each printed row is a field. Read one printed row at a time, label included.
 */
export interface ColumnTable {
  id: string;
  label: string;
  orientation: 'columns';
  /** From the printed row labels on the left to the last record column. */
  rect: NormRect | null;
  /** Where the record columns start, and how many there are. */
  cells: { x: number; w: number };
  records: number;
  fields: TableRowField[];
  /**
   * How far the printed rows drop per unit across the page (a turned photo); 0 when
   * level. Each cell is cropped at its own height, so a row never runs into the next.
   */
  slope?: number;
}

export type TableDef = RowTable | ColumnTable;

/**
 * A rule the data must follow, e.g. "area == B * C" or "temp2h <= 70".
 * `==` allows a small difference (the form's rounding): `tolerance` absolute, or
 * 1% of the larger side when left out. With `table`, the rule runs on every row
 * (record) of that table, and names refer to its columns first, then to fields.
 */
export interface CheckDef {
  id: string;
  label: string;
  rule: string;
  table?: string;
  tolerance?: number;
}

/** A table's value definitions: its columns, or a sideways table's printed rows. */
export const defsOf = (t: TableDef): FieldDef[] => (t.orientation === 'rows' ? t.columns : t.fields);

export interface FormTemplate {
  kind: 'form';
  version: 1;
  id: string;
  name: string;
  description?: string;
  /** Where the blank form comes from. */
  source?: string;
  fields: BoxField[];
  tables: TableDef[];
  checks: CheckDef[];
  /** Printed labels and where they are, to recognise the form and line up new photos. */
  anchors?: Anchor[];
  /** Built-in template this one started from. */
  builtinId?: string;
  photoUri: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A read value. Text that could not be parsed as its kind is kept as text. */
export type TimeTemp = { time: string | null; temp: number | null };
export type Value = string | number | boolean | TimeTemp | null;
export type DataRow = Record<string, Value>;

/** What one photo of a form says. */
export interface FormData {
  template: { id: string; name: string };
  source: string;
  readAt: number;
  fields: Record<string, Value>;
  tables: Record<string, DataRow[]>;
  /** Values that didn't parse as their kind, and parts the model failed on. */
  issues: string[];
}

export interface CheckResult {
  id: string;
  label: string;
  table?: string;
  /** Row (record) number, from 1. */
  row?: number;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}
