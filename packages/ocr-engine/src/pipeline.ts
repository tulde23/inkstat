import { columnSlice, stripCount, tileRects, toPixels } from './geometry';
import { coerce, describeSchema, extractJson, toJsonSchema } from './schema';
import type {
  DocumentTemplate,
  ExtractionProgress,
  ExtractionRun,
  GenerateResult,
  ImageOps,
  RegionResult,
  RegionSpec,
  VisionBackend,
} from './types';

export interface RunOptions {
  onProgress?: (p: ExtractionProgress) => void;
  signal?: AbortSignal;
  /** Extra attempts when the output is not valid JSON. */
  retries?: number;
  /** Only run these regions (e.g. re-read one area after the user fixes a crop). */
  regionIds?: string[];
}

const DEFAULT_MAX_SIDE = 1024;
const DEFAULT_MAX_TOKENS = 1024;
/** Hard ceiling when a cut-off answer earns a bigger budget on retry. */
const MAX_TOKEN_CEILING = 2048;

/** How a region's columns are sent: full width, as separate images, or joined into one image. */
export type ColumnLayout = 'full' | 'separate' | 'joined';

export function columnLayout(region: RegionSpec, images: Pick<ImageOps, 'join'>): ColumnLayout {
  if (region.pieces?.length) {
    if (region.pieces.length === 1) return 'full';
    return images.join ? 'joined' : 'separate';
  }
  if (!region.columns?.length) return 'full';
  if (!region.joinColumns) return 'separate';
  // Joining needs native image compositing; without it, fall back to the whole strip.
  return images.join ? 'joined' : 'full';
}

export function buildPrompt(
  template: DocumentTemplate,
  region: RegionSpec,
  tile: number,
  tiles: number,
  layout: ColumnLayout = region.columns?.length && !region.joinColumns ? 'separate' : 'full',
) {
  const cols = region.pieces ?? region.columns ?? [];
  const images = region.pieces?.length
    ? cols.length < 2
      ? ''
      : layout === 'joined'
        ? region.stackPieces
          ? `\nThis image is ${cols.length} separate boxes cut from the page and stacked top to bottom, ` +
            'separated by dark horizontal bars. From top to bottom: ' +
            cols.map((c) => c.label).join(' | ') +
            '. Read each box on its own.'
          : `\nThis image is ${cols.length} separate boxes cut from the page and joined left to right, ` +
            'separated by dark vertical bars: ' +
            cols.map((c) => c.label).join(' | ') +
            '. Read each box on its own.'
        : `\nYou are given ${cols.length} images, each a separate box from the page: ` +
          cols.map((c, i) => `image ${i + 1} is the ${c.label}`).join('; ') +
          '.'
    : layout === 'separate' && cols.length > 1
      ? `\nYou are given ${cols.length} images of the SAME rows, side by side on the page: ` +
        cols.map((c, i) => `image ${i + 1} is the ${c.label}`).join('; ') +
        '. Row k in one image is row k in the others; match them top to bottom.'
      : layout === 'joined' && cols.length > 1
        ? '\nThe middle of each row has been cut out to make the important columns larger. ' +
          'From left to right, separated by dark vertical bars: ' +
          cols.map((c) => c.label).join(' | ') +
          '. Each row still runs straight across the image.'
        : '';
  const part =
    tiles > 1
      ? `\n${layout === 'separate' ? 'These images are' : 'This image is'} strip ${tile + 1} of ${tiles} cut from the same area, top to bottom. ` +
        'Rows cut off at the top or bottom edge may be partial; include them only if you can read them.'
      : '';
  return (
    `${region.prompt}${images}${part}\n\n` +
    'Respond with JSON only, in exactly this shape:\n' +
    describeSchema(region.schema) +
    '\nUse null for anything blank or unreadable. Do not guess, and do not repeat a value just because the row above had it.'
  );
}

/**
 * Decide what the next attempt should change. A parse failure after a normal
 * stop is often a fluke worth one warmer retry; output that hit the token cap
 * will be cut off again unless the budget grows.
 */
export function nextAttempt(
  last: Pick<GenerateResult, 'hitTokenLimit'>,
  maxTokens: number,
): { maxTokens: number; temperature: number } | null {
  if (last.hitTokenLimit) {
    if (maxTokens >= MAX_TOKEN_CEILING) return null;
    return { maxTokens: Math.min(MAX_TOKEN_CEILING, maxTokens * 2), temperature: 0 };
  }
  return { maxTokens, temperature: 0.3 };
}

/** Read every region of a page image with the given backend. */
export async function runTemplate(
  backend: VisionBackend,
  images: ImageOps,
  sourceUri: string,
  template: DocumentTemplate,
  options: RunOptions = {},
): Promise<ExtractionRun> {
  const startedAt = Date.now();
  const { width, height } = await images.size(sourceUri);
  const regions = options.regionIds
    ? template.regions.filter((r) => options.regionIds!.includes(r.id))
    : template.regions;

  const jobs = regions.flatMap((region) =>
    (region.pieces?.length
      ? [region.rect]
      : tileRects(
          region.rect,
          region.tiles,
          stripCount(region, width, height, columnLayout(region, images) === 'joined'),
        )
    ).map((rect, tileIndex, all) => ({
      region,
      rect,
      tileIndex,
      tileCount: all.length,
    })),
  );

  const results: RegionResult[] = [];
  for (const [i, job] of jobs.entries()) {
    if (options.signal?.aborted) throw new Error('Extraction cancelled');
    let maxTokens = job.region.maxTokens ?? DEFAULT_MAX_TOKENS;
    const report = (phase: ExtractionProgress['phase'], tokens: number) =>
      options.onProgress?.({
        done: i,
        total: jobs.length,
        regionId: job.region.id,
        tileIndex: job.tileIndex,
        tileCount: job.tileCount,
        phase,
        tokens,
        maxTokens,
      });
    report('looking', 0);

    const t0 = Date.now();
    const maxSide = job.region.maxImageSide ?? DEFAULT_MAX_SIDE;
    const layout = columnLayout(job.region, images);
    const slices = job.region.pieces?.length
      ? job.region.pieces.map((p) => p.rect)
      : layout === 'full'
        ? [job.rect]
        : job.region.columns!.map((c) => columnSlice(c, job.region.rect, job.rect));
    let imageUris: string[] = [];
    for (const slice of slices) {
      imageUris.push(await images.crop(sourceUri, toPixels(slice, width, height), maxSide));
    }
    if (layout === 'joined') {
      const vertical = !!job.region.stackPieces && !!job.region.pieces?.length;
      imageUris = [await images.join!(imageUris, { vertical })];
    }
    const imageUri = imageUris[0];
    const prompt = buildPrompt(template, job.region, job.tileIndex, job.tileCount, layout);
    const jsonSchema = toJsonSchema(job.region.schema);
    const maxAttempts = 1 + (options.retries ?? 1);

    let raw = '';
    let error: string | undefined;
    let data: unknown = null;
    let warnings: string[] = [];
    let attempts = 0;
    let temperature = 0;
    let last: GenerateResult | null = null;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        last = await backend.generate({
          imageUris,
          system: template.systemPrompt,
          prompt,
          jsonSchema,
          maxTokens,
          temperature,
          signal: options.signal,
          onToken: (n) => report('writing', n),
        });
        raw = last.text;
        const coerced = coerce(job.region.schema, extractJson(raw));
        data = coerced.value;
        warnings = coerced.warnings;
        error = undefined;
        break;
      } catch (e) {
        if (options.signal?.aborted) throw e;
        error = e instanceof Error ? e.message : String(e);
        if (last?.hitTokenLimit) error = `Answer was cut off at ${maxTokens} tokens`;
        const next = last ? nextAttempt(last, maxTokens) : { maxTokens, temperature: 0.3 };
        if (!next) break;
        maxTokens = next.maxTokens;
        temperature = next.temperature;
        last = null;
      }
    }

    results.push({
      regionId: job.region.id,
      tileIndex: job.tileIndex,
      tileCount: job.tileCount,
      rect: job.rect,
      imageUri,
      imageUris,
      data,
      raw,
      warnings,
      error,
      attempts,
      durationMs: Date.now() - t0,
    });
  }
  options.onProgress?.({
    done: jobs.length,
    total: jobs.length,
    regionId: '',
    tileIndex: 0,
    tileCount: 0,
    phase: 'finished',
    tokens: 0,
    maxTokens: 0,
  });

  return {
    templateId: template.id,
    templateVersion: template.version,
    modelId: backend.modelId,
    sourceUri,
    results,
    startedAt,
    finishedAt: Date.now(),
  };
}

/** Results for one region, in tile order. */
export function resultsFor(run: ExtractionRun, regionId: string): RegionResult[] {
  return run.results
    .filter((r) => r.regionId === regionId)
    .sort((a, b) => a.tileIndex - b.tileIndex);
}

/**
 * Replace parts of a template's regions, e.g. with a layout the user marked for
 * their kind of document. Regions not named keep their defaults.
 */
export function withRegionOverrides(
  template: DocumentTemplate,
  overrides: Record<string, Partial<Omit<RegionSpec, 'id'>>>,
): DocumentTemplate {
  return {
    ...template,
    regions: template.regions.map((r) => (overrides[r.id] ? { ...r, ...overrides[r.id] } : r)),
  };
}
