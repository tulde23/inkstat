import { tileRects, toPixels } from '../geometry';
import { resultsFor, runTemplate } from '../pipeline';
import type { DocumentTemplate, GenerateRequest, ImageOps, VisionBackend } from '../types';

describe('tileRects', () => {
  it('returns the region itself without tiling', () => {
    const r = { x: 0, y: 0.1, w: 1, h: 0.8 };
    expect(tileRects(r)).toEqual([r]);
  });

  it('covers the region exactly with overlapping strips', () => {
    const r = { x: 0, y: 0.1, w: 1, h: 0.8 };
    const tiles = tileRects(r, { rows: 3, overlap: 0.2 });
    expect(tiles).toHaveLength(3);
    expect(tiles[0].y).toBeCloseTo(0.1);
    const last = tiles[2];
    expect(last.y + last.h).toBeCloseTo(0.9);
    // Each strip starts before the previous one ends.
    expect(tiles[1].y).toBeLessThan(tiles[0].y + tiles[0].h);
  });
});

describe('toPixels', () => {
  it('maps and clamps to the image', () => {
    expect(toPixels({ x: 0.5, y: 0.5, w: 0.7, h: 0.7 }, 1000, 800)).toEqual({
      originX: 500,
      originY: 400,
      width: 500,
      height: 400,
    });
  });
});

const fakeImages: ImageOps = {
  size: async () => ({ width: 1000, height: 1000 }),
  crop: async (_uri, rect) => `crop://${rect.originY}`,
};

/** A reply is the text, or { text, cut } to simulate stopping at the token limit. */
type Reply = string | { text: string; cut: true };

function fakeBackend(replies: Reply[]): VisionBackend & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    modelId: 'fake',
    calls,
    generate: async (req) => {
      calls.push({ ...req });
      const next = replies.shift();
      if (next === undefined) throw new Error('no more replies');
      const text = typeof next === 'string' ? next : next.text;
      for (let n = 1; n <= 3; n++) req.onToken?.(n);
      return { text, hitTokenLimit: typeof next !== 'string', tokens: 3 };
    },
  };
}

const template: DocumentTemplate = {
  id: 'test',
  name: 'Test',
  version: 1,
  regions: [
    {
      id: 'rows',
      label: 'Rows',
      rect: { x: 0, y: 0, w: 1, h: 1 },
      tiles: { rows: 2, overlap: 0 },
      prompt: 'Read rows',
      schema: { type: 'object', properties: { n: { type: 'integer', nullable: true } } },
    },
  ],
};

describe('runTemplate', () => {
  it('runs every tile and coerces the output', async () => {
    const backend = fakeBackend(['{"n": "4"}', '{"n": 7}']);
    const run = await runTemplate(backend, fakeImages, 'page.jpg', template);
    const rows = resultsFor(run, 'rows');
    expect(rows.map((r) => r.data)).toEqual([{ n: 4 }, { n: 7 }]);
    expect(rows.map((r) => r.imageUri)).toEqual(['crop://0', 'crop://500']);
    expect(backend.calls[1].prompt).toContain('strip 2 of 2');
    expect(backend.calls[0].jsonSchema).toBeDefined();
  });

  it('retries once on unreadable output, with a little temperature', async () => {
    const backend = fakeBackend(['garbage', '{"n": 1}', '{"n": 2}']);
    const run = await runTemplate(backend, fakeImages, 'page.jpg', template);
    expect(run.results[0]).toMatchObject({ data: { n: 1 }, attempts: 2, error: undefined });
    expect(backend.calls.map((c) => c.temperature)).toEqual([0, 0.3, 0]);
  });

  it('records a failure instead of throwing when retries run out', async () => {
    const backend = fakeBackend(['nope', 'still nope', '{"n": 2}']);
    const run = await runTemplate(backend, fakeImages, 'page.jpg', template);
    expect(run.results[0].data).toBeNull();
    expect(run.results[0].error).toMatch(/No JSON/);
    expect(run.results[1].data).toEqual({ n: 2 });
  });

  it('sends one image per column slice, cropped to each strip', async () => {
    const crops: string[] = [];
    const recording: ImageOps = {
      size: async () => ({ width: 1000, height: 1000 }),
      crop: async (_uri, r) => {
        const id = `${r.originX},${r.originY},${r.width}x${r.height}`;
        crops.push(id);
        return id;
      },
    };
    const withColumns: DocumentTemplate = {
      ...template,
      regions: [
        {
          ...template.regions[0],
          columns: [
            { x: 0, w: 0.3, label: 'names' },
            { x: 0.7, w: 0.3, label: 'totals' },
          ],
        },
      ],
    };
    const backend = fakeBackend(['{"n": 1}', '{"n": 2}']);
    const run = await runTemplate(backend, recording, 'page.jpg', withColumns);
    expect(backend.calls[0].imageUris).toEqual(['0,0,300x500', '700,0,300x500']);
    expect(backend.calls[1].imageUris).toEqual(['0,500,300x500', '700,500,300x500']);
    expect(backend.calls[0].prompt).toContain('image 1 is the names; image 2 is the totals');
    expect(run.results[1].imageUris).toHaveLength(2);
    expect(crops).toHaveLength(4);
  });

  it('follows a leaning column down the page, strip by strip', async () => {
    const crops: string[] = [];
    const recording: ImageOps = {
      size: async () => ({ width: 1000, height: 1000 }),
      crop: async (_uri, r) => {
        const id = `${r.originX},${r.originY},${r.width}x${r.height}`;
        crops.push(id);
        return id;
      },
    };
    const leaning: DocumentTemplate = {
      ...template,
      regions: [{ ...template.regions[0], columns: [{ x: 0.5, w: 0.25, lean: 0.25, label: 'totals' }] }],
    };
    const backend = fakeBackend(['{"n": 1}', '{"n": 2}']);
    await runTemplate(backend, recording, 'page.jpg', leaning);
    // Top strip: the edge moves 0.5 -> 0.625; bottom strip: 0.625 -> 0.75.
    expect(backend.calls[0].imageUris).toEqual(['500,0,375x500']);
    expect(backend.calls[1].imageUris).toEqual(['625,500,375x500']);
  });

  describe('joined columns', () => {
    const joined: DocumentTemplate = {
      ...template,
      regions: [
        {
          ...template.regions[0],
          columns: [
            { x: 0, w: 0.3, label: 'names' },
            { x: 0.7, w: 0.3, label: 'totals' },
          ],
          joinColumns: true,
        },
      ],
    };
    const cropOps = (log: string[]): ImageOps => ({
      size: async () => ({ width: 1000, height: 1000 }),
      crop: async (_u, r) => {
        const id = `${r.originX},${r.originY},${r.width}x${r.height}`;
        log.push(id);
        return id;
      },
    });

    it('crops each slice and sends one joined image per strip', async () => {
      const crops: string[] = [];
      const ops = { ...cropOps(crops), join: async (uris: string[]) => `join(${uris.join('+')})` };
      const backend = fakeBackend(['{"n": 1}', '{"n": 2}']);
      await runTemplate(backend, ops, 'page.jpg', joined);
      expect(backend.calls[0].imageUris).toEqual(['join(0,0,300x500+700,0,300x500)']);
      expect(backend.calls[0].prompt).toContain('names | totals');
      expect(backend.calls[0].prompt).not.toContain('You are given');
    });

    it('falls back to the full-width strip when images cannot be joined', async () => {
      const crops: string[] = [];
      const backend = fakeBackend(['{"n": 1}', '{"n": 2}']);
      await runTemplate(backend, cropOps(crops), 'page.jpg', joined);
      expect(backend.calls[0].imageUris).toEqual(['0,0,1000x500']);
      expect(backend.calls[0].prompt).not.toContain('cut out');
    });
  });

  describe('pieces', () => {
    const header: DocumentTemplate = {
      ...template,
      regions: [
        {
          ...template.regions[0],
          tiles: { rows: 4, overlap: 0.1 },
          pieces: [
            { rect: { x: 0.125, y: 0, w: 0.25, h: 0.125 }, label: 'team name' },
            { rect: { x: 0.5, y: 0, w: 0.125, h: 0.125 }, label: 'date' },
          ],
        },
      ],
    };
    const ops = (log: string[]): ImageOps => ({
      size: async () => ({ width: 1000, height: 1000 }),
      crop: async (_u, r) => {
        const id = `${r.originX},${r.originY},${r.width}x${r.height}`;
        log.push(id);
        return id;
      },
      join: async (uris) => `join(${uris.join('+')})`,
    });

    it('crops each box, joins them in order, and reads them once (never tiled)', async () => {
      const crops: string[] = [];
      const backend = fakeBackend(['{"n": 1}']);
      const run = await runTemplate(backend, ops(crops), 'page.jpg', header);
      expect(backend.calls).toHaveLength(1);
      expect(backend.calls[0].imageUris).toEqual(['join(125,0,250x125+500,0,125x125)']);
      expect(backend.calls[0].prompt).toContain('team name | date');
      expect(backend.calls[0].prompt).toContain('separate boxes');
      expect(run.results[0].imageUris).toEqual(['join(125,0,250x125+500,0,125x125)']);
    });

    it('crops a single piece on its own', async () => {
      const one = { ...header, regions: [{ ...header.regions[0], pieces: [header.regions[0].pieces![1]] }] };
      const backend = fakeBackend(['{"n": 1}']);
      await runTemplate(backend, ops([]), 'page.jpg', one);
      expect(backend.calls[0].imageUris).toEqual(['500,0,125x125']);
      expect(backend.calls[0].prompt).not.toContain('separate boxes');
    });
  });

  it('gives a cut-off answer a bigger budget instead of a warmer retry', async () => {
    const backend = fakeBackend([{ text: '{"n": 1', cut: true }, '{"n": 1}', '{"n": 2}']);
    const run = await runTemplate(backend, fakeImages, 'page.jpg', template);
    expect(run.results[0]).toMatchObject({ data: { n: 1 }, attempts: 2 });
    expect(backend.calls.map((c) => [c.maxTokens, c.temperature])).toEqual([
      [1024, 0],
      [2048, 0],
      [1024, 0],
    ]);
  });

  it('gives up on a cut-off answer once the budget is at its ceiling', async () => {
    const big: DocumentTemplate = {
      ...template,
      regions: [{ ...template.regions[0], tiles: undefined, maxTokens: 2048 }],
    };
    const backend = fakeBackend([{ text: '{"n": ', cut: true }, '{"n": 9}']);
    const run = await runTemplate(backend, fakeImages, 'page.jpg', big);
    expect(run.results[0]).toMatchObject({ data: null, attempts: 1, error: 'Answer was cut off at 2048 tokens' });
    expect(backend.calls).toHaveLength(1);
  });

  it('reports looking, then writing with token counts, then finished', async () => {
    const seen: string[] = [];
    await runTemplate(fakeBackend(['{"n": 1}', '{"n": 2}']), fakeImages, 'page.jpg', template, {
      onProgress: (p) => seen.push(`${p.done}/${p.total} ${p.phase}${p.phase === 'writing' ? ` ${p.tokens}` : ''}`),
    });
    expect(seen).toEqual([
      '0/2 looking',
      '0/2 writing 1',
      '0/2 writing 2',
      '0/2 writing 3',
      '1/2 looking',
      '1/2 writing 1',
      '1/2 writing 2',
      '1/2 writing 3',
      '2/2 finished',
    ]);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTemplate(fakeBackend([]), fakeImages, 'page.jpg', template, { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
});

describe('stacked pieces', () => {
  it('asks the image ops to stack pieces vertically and says so in the prompt', async () => {
    const calls: { uris: string[]; vertical?: boolean }[] = [];
    const ops: ImageOps = {
      size: async () => ({ width: 1000, height: 1000 }),
      crop: async (_u, r) => `${r.originX},${r.originY}`,
      join: async (uris, o) => {
        calls.push({ uris, vertical: o?.vertical });
        return 'joined';
      },
    };
    const backend = fakeBackend(['{"n": 1}']);
    const doc: DocumentTemplate = {
      id: 't',
      name: 't',
      version: 1,
      regions: [
        {
          id: 'details',
          label: 'Details',
          rect: { x: 0, y: 0, w: 0.5, h: 0.1 },
          prompt: 'Read.',
          schema: { type: 'object', properties: { n: { type: 'integer', nullable: true } } },
          pieces: [
            { rect: { x: 0, y: 0, w: 0.25, h: 0.125 }, label: 'team name' },
            { rect: { x: 0.5, y: 0, w: 0.25, h: 0.125 }, label: 'date' },
          ],
          stackPieces: true,
        },
      ],
    };
    await runTemplate(backend, ops, 'page.jpg', doc);
    expect(calls).toEqual([{ uris: ['0,0', '500,0'], vertical: true }]);
    expect(backend.calls[0].prompt).toContain('stacked top to bottom');
    expect(backend.calls[0].prompt).toContain('team name | date');
  });
});
