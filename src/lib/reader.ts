import { File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Image } from 'react-native';

import type { DocumentTemplate, ExtractionProgress } from '@inkstat/ocr-engine';
import { documentFor, LIBRARY, readForm, recognize, runChecks, templateForPhoto, type FormMatch, type FormTemplate } from '@inkstat/forms';

import { READ_IN_PROGRESS_KEY, clearSetting, listTemplates, saveRead, setSetting, type SavedRead } from '@/db';
import { extract, getActiveModelId } from '@/engine/host';
import { keepImage, newId } from '@/lib/files';

import { recognizePageText } from '../../modules/page-text';

/** Built-in templates plus the user's own: the user's first, so their edits win. */
export async function allTemplates(db: SQLiteDatabase): Promise<FormTemplate[]> {
  const mine = await listTemplates(db);
  const replaced = new Set(mine.map((t) => t.builtinId).filter(Boolean));
  return [...mine, ...LIBRARY.filter((t) => !replaced.has(t.id))];
}

/** Which form a photo is, from its printed words; null when nothing matches well enough. */
export async function recognizePhoto(db: SQLiteDatabase, uri: string): Promise<{ match: FormMatch | null; words: number }> {
  const lines = (await recognizePageText(uri).catch(() => null)) ?? [];
  const match = recognize(lines, await allTemplates(db));
  console.log(`[scan] recognised: ${match ? `${match.template.id} ${match.match.inliers}/${match.match.total}` : `nothing (${lines.length} lines)`}`);
  return { match, words: lines.length };
}

// Bundled made-up filled-in copies of the built-in forms, to try a template without paper.
const SAMPLES: Record<string, number> = {
  'ridot-tf2': require('../../assets/samples/ridot-tf2.jpg'),
  'la-dotd-0740': require('../../assets/samples/la-dotd-0740.jpg'),
  'mn-cooling-log': require('../../assets/samples/mn-cooling-log.jpg'),
};

export const hasSample = (templateId: string) => templateId in SAMPLES;

/**
 * A template lined up with a photo of its form by the printed words, as a read does:
 * a sample is a photo, not the flat blank page the boxes were measured on.
 */
export async function alignedTo(t: FormTemplate, uri: string): Promise<FormTemplate> {
  return templateForPhoto(t, await recognizePageText(uri).catch(() => null)).template;
}

/** The sample photo as a file the reader can crop. */
export async function samplePhoto(templateId: string): Promise<string> {
  const src = Image.resolveAssetSource(SAMPLES[templateId])?.uri ?? '';
  if (src.startsWith('file:')) return src;
  const dest = new File(Paths.cache, `sample-${templateId}.jpg`);
  if (dest.exists) dest.delete();
  // Development builds serve assets from Metro; release builds need expo-asset for this.
  if (/^https?:/.test(src)) return (await File.downloadFileAsync(src, dest)).uri;
  throw new Error('Samples are only available in development builds for now.');
}

export interface ReadStatus {
  text: string;
  fraction: number;
  /** The photo, the plan and the crop being read, for the reading animation. */
  uri: string;
  doc: DocumentTemplate | null;
  progress: ExtractionProgress | null;
}

/**
 * Read a photo with a template: line the template up with the photo's printed
 * labels, read every box and table, check, and save. Returns the saved read.
 */
export async function readPhoto(
  db: SQLiteDatabase,
  template: FormTemplate,
  photo: string,
  onStatus: (s: ReadStatus) => void,
  signal?: AbortSignal,
): Promise<SavedRead> {
  const id = newId();
  // If Android kills InkStat for memory mid-read, nothing in JS runs; this marker lets
  // the next launch say what happened.
  await setSetting(db, READ_IN_PROGRESS_KEY, String(Date.now()));
  try {
    const uri = keepImage(photo, id, 'page');
    onStatus({ text: 'Lining the template up with the photo…', fraction: 0, uri, doc: null, progress: null });
    const lines = await recognizePageText(uri).catch(() => null);
    const { template: aligned, aligned: ok } = templateForPhoto(template, lines);
    console.log(`[scan] ${template.id}: ${ok ? 'aligned by printed labels' : 'as saved'}`);
    const doc = documentFor(aligned);
    const modelId = await getActiveModelId(db);
    const t0 = Date.now();
    const run = await extract(modelId, uri, doc, {
      signal,
      onModelLoad: (f) => onStatus({ text: 'Loading the reading model…', fraction: f * 0.05, uri, doc, progress: null }),
      onProgress: (p) => {
        if (p.phase !== 'writing') console.log(`[scan] ${p.phase} ${p.done + 1}/${p.total} ${p.regionId}#${p.tileIndex} +${Date.now() - t0}ms`);
        const label = doc.regions.find((r) => r.id === p.regionId)?.label ?? '';
        const within = p.phase === 'finished' ? 1 : p.phase === 'looking' ? 0.05 : 0.4 + 0.6 * Math.min(1, p.tokens / Math.max(1, p.maxTokens * 0.6));
        onStatus({ text: `Reading ${label}`, fraction: 0.05 + 0.95 * ((p.done + within) / Math.max(1, p.total)), uri, doc, progress: p });
      },
    });
    for (const r of run.results) console.log(`[scan] raw ${r.regionId}#${r.tileIndex}: ${r.raw.replace(/\s+/g, ' ').slice(0, 800)}`);
    const data = readForm(aligned, run);
    const now = Date.now();
    const saved: SavedRead = {
      id,
      template: aligned,
      photoUri: uri,
      data,
      checks: runChecks(aligned, data),
      modelId: run.modelId,
      seconds: Math.round((run.finishedAt - run.startedAt) / 1000),
      createdAt: now,
      updatedAt: now,
    };
    await saveRead(db, saved);
    return saved;
  } finally {
    await clearSetting(db, READ_IN_PROGRESS_KEY);
  }
}
