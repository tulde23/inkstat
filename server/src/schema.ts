import { z } from 'zod';

import type { Game } from '@inkstat/basketball';

import { sheetSchema } from './sanitize';

const stat = z.number().int().min(0).max(1000).nullable();
const text = (max: number) => z.string().max(max).nullable();

const player = z.object({
  number: text(10),
  name: text(80),
  fouls: stat,
  fg2: stat,
  fg3: stat,
  ftMade: stat,
  ftAttempted: stat,
  points: stat,
  readNotes: z.array(z.string().max(300)).max(50),
});

const team = z.object({
  name: text(80),
  periodScores: z.array(stat).max(12),
  totalPoints: stat,
  timeoutsUsed: stat,
  coach: text(80).optional(),
  halfScore: stat.optional(),
  teamFouls: z.array(stat).max(8).optional(),
  players: z.array(player).max(40),
  pageUri: text(2000),
  crops: z.array(z.object({ regionId: z.string().max(60), uri: z.string().max(2000) })).max(20),
});

export const gameSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{6,40}$/i, 'id must be 6-40 letters or digits'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be yyyy-mm-dd').nullable(),
  location: text(120),
  season: z.string().regex(/^\d{4}-\d{2}$/, 'season must look like 2026-27'),
  home: team,
  away: team,
  modelId: text(80),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

// Compile-time guard: the wire schema and the shared Game type must not drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _schemaMatchesGame: Same<z.infer<typeof gameSchema>, Game> = true;
void _schemaMatchesGame;

/** Page photos and crops are file paths on the phone that took them; meaningless anywhere else. */
export function stripDeviceFiles(game: Game): Game {
  return {
    ...game,
    home: { ...game.home, pageUri: null, crops: [] },
    away: { ...game.away, pageUri: null, crops: [] },
  };
}

const unit = z.number().min(-0.5).max(1.5);
/**
 * A scorebook template as the app stores it (version 3), for personal sync. Private to
 * its owner, so anchors stay as they are; the photo is a file on one phone and is dropped.
 */
export const templateSchema = z.object({
  version: z.literal(3),
  sport: z.string().max(40),
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  enabled: z.array(z.string().max(40)).max(80),
  parts: z.record(z.string().max(40), z.union([z.object({ x: unit, y: unit, w: unit, h: unit }), z.object({ x: unit, w: unit })])),
  variants: z.record(z.string().max(40), z.string().max(40)),
  photoUri: z.string().max(2000).nullable(),
  anchors: z.array(z.object({ text: z.string().max(120), x: unit, y: unit })).max(2000).optional(),
  builtinId: z.string().max(80).optional(),
  /** One team or both on a page, and where home is. */
  sheet: sheetSchema.optional(),
  test: z.object({ at: z.number(), seconds: z.number(), checks: z.number(), problems: z.number() }).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
