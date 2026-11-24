/**
 * Core types for the OCR engine. Nothing in this package may know about a
 * specific document type (basketball, receipts, ...). Domains describe their
 * documents with a DocumentTemplate and interpret the JSON that comes back.
 */

/** Rectangle in normalized page coordinates: 0..1 on both axes, origin top-left. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangle in source-image pixels. */
export interface PixelRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * The small JSON Schema subset the engine understands. It is sent to llama.cpp
 * as a grammar constraint, and used again after generation to coerce and check
 * the output, because small models still drift (numbers as strings, etc.).
 */
export type FieldSchema =
  | { type: 'string'; description?: string; nullable?: boolean; enum?: string[] }
  | {
      type: 'integer' | 'number';
      description?: string;
      nullable?: boolean;
      minimum?: number;
      maximum?: number;
    }
  | { type: 'boolean'; description?: string; nullable?: boolean }
  | { type: 'array'; items: FieldSchema; description?: string; maxItems?: number }
  | {
      type: 'object';
      properties: Record<string, FieldSchema>;
      required?: string[];
      description?: string;
    };

/** A fixed number of horizontal strips. */
export interface FixedTileSpec {
  /** Number of horizontal strips to cut the region into. */
  rows: number;
  /** Fraction of a strip's height shared with its neighbour, so rows on a seam are not lost. */
  overlap: number;
}

/**
 * As many strips as it takes for each crop to have roughly this width:height
 * ratio. Models that resize to a square (Gemini Nano) read best near 1, since
 * nothing gets squeezed.
 */
export interface AspectTileSpec {
  targetAspect: number;
  overlap: number;
  minRows?: number;
  maxRows?: number;
}

export type TileSpec = FixedTileSpec | AspectTileSpec;

/**
 * A vertical slice of a region, in page coordinates (0..1). Wide tables often
 * have the useful columns far apart (names at the left, totals at the right);
 * sending just those slices, as separate images of the same rows, removes the
 * clutter in between and keeps each slice at full resolution.
 */
export interface ColumnSpec {
  x: number;
  w: number;
  /** The left edge's sideways shift from the region's top to its bottom: a leaning column. */
  lean?: number;
  /** Told to the model, e.g. "jersey number and name columns". */
  label: string;
}

/** One area of the page to read, and what to read out of it. */
export interface PieceSpec {
  rect: NormRect;
  /** What the piece holds, as the model is told it (e.g. "coach's name"). */
  label: string;
}

export interface RegionSpec {
  id: string;
  label: string;
  rect: NormRect;
  prompt: string;
  schema: FieldSchema;
  /** Split tall, dense regions (tables) into strips; small models read small crops far better. */
  tiles?: TileSpec;
  /** Send only these column slices of each strip, as one image per slice, instead of the full width. */
  columns?: ColumnSpec[];
  /**
   * Join the column slices side by side into ONE image (cutting out the middle).
   * Rows stay aligned, unlike separate images, and narrow-input models see the kept
   * columns larger. If the device cannot join images, the full-width strip is sent.
   */
  joinColumns?: boolean;
  /**
   * Rows that slope on a turned photo: how far a row drops per unit across the page.
   * Each column slice is cropped at its own height (see columnSlice), so a row's cells
   * land in the same strip.
   */
  slope?: number;
  /**
   * Separate small boxes read in ONE request (e.g. team name, coach and date in a
   * page header): each is cropped, then they are joined side by side, left to right
   * in this order. Overrides `rect` for cropping; never tiled. Without native
   * joining they are sent as separate images.
   */
  pieces?: PieceSpec[];
  /**
   * Stack the pieces top to bottom instead of side by side. Several small, wide
   * boxes (header fields) then make a near-square image, so a model that resizes
   * its input to a square keeps the handwriting large.
   */
  stackPieces?: boolean;
  /** Longest side, in pixels, of each crop sent to the model. */
  maxImageSide?: number;
  maxTokens?: number;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  version: number;
  /** Prepended to every region's prompt. */
  systemPrompt?: string;
  regions: RegionSpec[];
}

export interface RegionResult {
  regionId: string;
  tileIndex: number;
  tileCount: number;
  /** Where on the page this crop came from (normalized). */
  rect: NormRect;
  /** The (first) crop that was sent to the model; useful for side-by-side review. */
  imageUri: string;
  /** Every crop sent for this tile: one per column slice, or just imageUri. */
  imageUris: string[];
  /** Parsed and coerced output, or null if the model never produced valid JSON. */
  data: unknown;
  raw: string;
  /** Problems found while coercing the output against the schema. */
  warnings: string[];
  error?: string;
  attempts: number;
  durationMs: number;
}

export interface ExtractionRun {
  templateId: string;
  templateVersion: number;
  modelId: string;
  sourceUri: string;
  results: RegionResult[];
  startedAt: number;
  finishedAt: number;
}

export interface ExtractionProgress {
  /** Crops finished so far, out of `total`. */
  done: number;
  total: number;
  regionId: string;
  tileIndex: number;
  tileCount: number;
  /** 'looking': encoding the image (no visible output); 'writing': generating tokens. */
  phase: 'looking' | 'writing' | 'finished';
  /** Tokens written so far for the current crop. */
  tokens: number;
  /** The current crop's output budget, for a within-crop progress estimate. */
  maxTokens: number;
}

/**
 * Anything that can turn (image, prompt, schema) into text. The on-device
 * llama.rn backend implements this; tests use a fake; a LAN server backend
 * could implement it later without touching the pipeline or any domain.
 */
export interface VisionBackend {
  readonly modelId: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export interface GenerateRequest {
  /** One or more images, in the order the prompt describes them. */
  imageUris: string[];
  system?: string;
  prompt: string;
  /** Plain JSON Schema (already converted from FieldSchema). */
  jsonSchema?: object;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Called as tokens are produced (count so far). The first call marks the end of image encoding. */
  onToken?: (count: number) => void;
}

export interface GenerateResult {
  text: string;
  /** True when generation stopped at maxTokens: the output is cut off, so retrying with the same budget is pointless. */
  hitTokenLimit: boolean;
  tokens: number;
}

/** Image operations the pipeline needs, abstracted so the pipeline is testable off-device. */
export interface ImageOps {
  size(uri: string): Promise<{ width: number; height: number }>;
  crop(uri: string, rect: PixelRect, maxSide: number): Promise<string>;
  /**
   * Optional: place images side by side (left to right) into one, or stacked top to
   * bottom with `vertical`. Needed for `joinColumns` and `pieces`.
   */
  join?(uris: string[], options?: { vertical?: boolean }): Promise<string>;
}

/** A word of text found on a page, with where it is (fractions of the image, 0..1). */
export interface TextWord {
  text: string;
  rect: NormRect;
}

/** A line of text found on a page (e.g. by on-device OCR), used to place template boxes. */
export interface TextLine extends TextWord {
  words: TextWord[];
}
