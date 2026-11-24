import type { NormRect, PixelRect, RegionSpec, TileSpec } from './types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * How many strips a region gets. For an aspect-based spec, the strip count is
 * chosen so each crop (after any column joining) is about targetAspect wide:high.
 */
export function stripCount(region: Pick<RegionSpec, 'rect' | 'tiles' | 'columns' | 'joinColumns'>, pageWidth: number, pageHeight: number, joined: boolean): number {
  const tiles = region.tiles;
  if (!tiles) return 1;
  if ('rows' in tiles) return Math.max(1, Math.floor(tiles.rows));
  const contentWidthPx =
    (joined && region.columns?.length ? region.columns.reduce((s, c) => s + c.w, 0) : region.rect.w) * pageWidth;
  const regionHeightPx = region.rect.h * pageHeight;
  const ideal = Math.round(regionHeightPx / Math.max(1, contentWidthPx / tiles.targetAspect));
  return Math.min(tiles.maxRows ?? 12, Math.max(tiles.minRows ?? 1, ideal));
}

/** Split a region into `rows` overlapping horizontal strips (top to bottom). */
export function tileRects(rect: NormRect, tiles?: TileSpec, rowsOverride?: number): NormRect[] {
  const rows = Math.max(1, Math.floor(rowsOverride ?? (tiles && 'rows' in tiles ? tiles.rows : 1)));
  if (rows === 1) return [rect];
  const overlap = Math.min(0.5, Math.max(0, tiles?.overlap ?? 0));
  // Strip height h satisfies: rows*h - (rows-1)*overlap*h = rect.h
  const h = rect.h / (rows - (rows - 1) * overlap);
  const step = h * (1 - overlap);
  return Array.from({ length: rows }, (_, i) => ({
    x: rect.x,
    y: rect.y + i * step,
    w: rect.w,
    h: i === rows - 1 ? rect.y + rect.h - (rect.y + i * step) : h,
  }));
}

/**
 * One column's part of one strip of its region. A leaning column moves sideways down
 * the page, so each strip takes the stretch of it that strip crosses (a little wider
 * than the column, by how far it leans within the strip). Strips are a few rows tall,
 * so the crops follow the lean closely without warping the image.
 *
 * On a turned photo the rows also slope: `slope` is how far a row drops per unit
 * across the page, and each column's slice is moved down by how far right of the
 * region's left edge it is, so a row's cells stay in the same strip across the table.
 */
export function columnSlice(
  column: { x: number; w: number; lean?: number },
  region: Pick<NormRect, 'y' | 'h'> & { x?: number },
  strip: Pick<NormRect, 'y' | 'h'>,
  slope = 0,
): NormRect {
  const lean = column.lean ?? 0;
  const at = (y: number) => column.x + lean * clamp01((y - region.y) / Math.max(1e-6, region.h));
  const a = at(strip.y);
  const b = at(strip.y + strip.h);
  const x = Math.min(a, b);
  const w = column.w + Math.abs(b - a);
  const dy = slope ? slope * (x + w / 2 - (region.x ?? 0)) : 0;
  return { x, y: strip.y + dy, w, h: strip.h };
}

/** Map a normalized rect onto an image, clamped to its bounds and at least 1px. */
export function toPixels(rect: NormRect, width: number, height: number): PixelRect {
  const x0 = clamp01(rect.x);
  const y0 = clamp01(rect.y);
  const x1 = clamp01(rect.x + rect.w);
  const y1 = clamp01(rect.y + rect.h);
  const originX = Math.floor(x0 * width);
  const originY = Math.floor(y0 * height);
  return {
    originX,
    originY,
    width: Math.max(1, Math.min(width - originX, Math.ceil(x1 * width) - originX)),
    height: Math.max(1, Math.min(height - originY, Math.ceil(y1 * height) - originY)),
  };
}
