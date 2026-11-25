import type { FormTemplate } from '@inkstat/forms';

import type { MarkerShape } from './PageMarker';

export const FIELD_COLOR = '#2F5DA8';
export const TABLE_COLOR = '#2F6F3E';
export const COLUMN_COLOR = '#C2610C';

/**
 * Every box a template reads, to draw on its page. Ids: `f:<field>`, `t:<table>`,
 * `c:<table>:<column>` for a row table's columns, `r:<table>:<field>` for a
 * sideways table's printed rows.
 */
export function shapesOf(t: FormTemplate): MarkerShape[] {
  return [
    ...t.fields.filter((f) => f.rect).map((f) => ({ id: `f:${f.id}`, rect: f.rect!, color: FIELD_COLOR, label: f.label })),
    ...t.tables.flatMap((table): MarkerShape[] => {
      const r = table.rect;
      if (!r) return [];
      const box = { id: `t:${table.id}`, rect: r, color: TABLE_COLOR, label: table.label };
      if (table.orientation === 'rows') {
        return [
          box,
          ...table.columns
            .filter((col) => col.band)
            .map((col) => ({ id: `c:${table.id}:${col.id}`, rect: { x: col.band!.x, y: r.y, w: col.band!.w, h: r.h }, color: COLUMN_COLOR, label: col.label, lean: col.band!.lean })),
        ];
      }
      return [
        box,
        ...table.fields
          .filter((f) => f.band)
          .map((f) => ({ id: `r:${table.id}:${f.id}`, rect: { x: r.x, y: f.band!.y, w: r.w, h: f.band!.h }, color: COLUMN_COLOR, label: f.label })),
      ];
    }),
  ];
}
