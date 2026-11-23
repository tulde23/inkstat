import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';

import { getGame, saveGame } from '@/db';
import { seasonFor, type Game, type Issue, type Side, type TeamSheet } from '@inkstat/basketball';
import type { Photo } from '@/ui/PhotoViewer';

/**
 * One game, loaded on focus so the summary, box score and check screens
 * always show each other's edits. Edits are discrete (a sheet's Save), so
 * each one is written straight away.
 */
export function useGame(id: string) {
  const db = useSQLiteContext();
  const [game, setGame] = useState<Game | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void getGame(db, id).then((g) => live && setGame(g));
      return () => {
        live = false;
      };
    }, [db, id]),
  );

  const update = useCallback(
    async (fn: (g: Game) => Game) => {
      const cur = await getGame(db, id);
      if (!cur) return;
      const next = { ...fn(cur), updatedAt: Date.now() };
      next.season = seasonFor(next.date);
      await saveGame(db, next);
      setGame(next);
    },
    [db, id],
  );

  return { game, update, setGame };
}

export const sideName = (g: Game, s: Side) => g[s].name ?? (s === 'home' ? 'Home' : 'Away');

/** "home.players.3.points" -> parts, so screens can find and edit the flagged value. */
export function parseIssuePath(path: string) {
  const [side, ...rest] = path.split('.') as [Side, ...string[]];
  if (rest[0] === 'players') return { side, kind: 'player' as const, row: Number(rest[1]), field: rest[2] };
  return { side, kind: 'team' as const, field: rest[0] };
}

const cropLabel = (regionId: string) => {
  if (regionId === 'summary') return 'Header and score by period';
  if (regionId === 'quarters') return 'Score by quarter';
  if (regionId === 'final_score') return 'Final score';
  if (regionId === 'half_score') return 'Half-time score';
  if (regionId === 'running_score') return 'Running score';
  if (regionId === 'timeouts') return 'Timeouts';
  if (regionId === 'team_fouls') return 'Team fouls';
  if (regionId.startsWith('detail_')) return regionId.slice(7).replace(/([A-Z])/g, ' $1').toLowerCase();
  const fouls = regionId.match(/^player_fouls-(\d+)/);
  if (fouls) return `Fouls, strip ${fouls[1]}`;
  const strip = regionId.match(/^players-(\d+)/);
  return strip ? `Player rows, strip ${strip[1]}` : regionId;
};

/** Every image InkStat read for a team: the page first, then each crop. */
export function teamPhotos(team: TeamSheet): Photo[] {
  return [
    ...(team.pageUri ? [{ uri: team.pageUri, label: 'Full page', page: true }] : []),
    ...team.crops.map((cr) => ({ uri: cr.uri, label: cropLabel(cr.regionId) })),
  ];
}

/**
 * The crops a flagged value was read from, best first, as indexes into
 * teamPhotos(team). Falls back to the full page.
 */
export function photosFor(team: TeamSheet, issue: Issue): number[] {
  const p = parseIssuePath(issue.path);
  const offset = team.pageUri ? 1 : 0;
  const want: ((r: string) => boolean)[] =
    p.kind === 'player'
      ? p.field === 'fouls'
        ? [(r) => r.startsWith('player_fouls'), (r) => r.startsWith('players')]
        : [(r) => r.startsWith('players')]
      : p.field === 'periodScores'
        ? [(r) => r === 'quarters', (r) => r === 'summary']
        : p.field === 'totalPoints'
          ? [(r) => r === 'final_score', (r) => r === 'quarters', (r) => r === 'summary']
          : p.field === 'halfScore'
            ? [(r) => r === 'half_score', (r) => r === 'quarters', (r) => r === 'summary']
            : p.field === 'runningScore'
              ? [(r) => r === 'running_score']
              : [];
  const out: number[] = [];
  for (const w of want) team.crops.forEach((cr, i) => w(cr.regionId) && !out.includes(i + offset) && out.push(i + offset));
  if (!out.length && team.pageUri) out.push(0);
  return out;
}
