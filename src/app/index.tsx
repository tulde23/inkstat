import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { READ_IN_PROGRESS_KEY, clearSetting, clearTombstone, deleteGame, getSetting, listGames, saveGame } from '@/db';
import {
  formatGamesBehind,
  formatPct,
  perGame,
  seasonFor,
  seasonTotals,
  standings,
  teamKey,
  teamScore,
  validateGame,
  type Game,
  type StandingRow,
} from '@inkstat/basketball';
import { activeModel, type ActiveModel } from '@/engine/host';
import { Badge, Button, Card, T } from '@/ui/components';
import { deleteGameImages } from '@/lib/files';
import { teamColors } from '@/lib/teamColor';
import { HeaderTabs, TeamBadge } from '@/ui/HeaderTabs';
import { LogoMark } from '@/ui/Logo';
import { SyncSheet } from '@/ui/SyncSheet';
import { useDialog } from '@/ui/Dialog';
import { useLightStatusBar } from '@/ui/useLightStatusBar';
import { THEME_LABEL, getThemePreference, setThemePreference } from '@/ui/themePreference';
import { base, fonts, space, useColors } from '@/ui/theme';

type Tab = 'standings' | 'scores' | 'leaders';

/**
 * Home is the league table, built from the games this scorekeeper has scanned:
 * standings, scores and leaders, with a big Scan button at the bottom.
 */
export default function Home() {
  const db = useSQLiteContext();
  const c = useColors();
  const dialog = useDialog();
  useLightStatusBar();
  const [all, setAll] = useState<Game[]>([]);
  const [season, setSeason] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('standings');
  const [colors, setColors] = useState<Record<string, string>>({});
  const [model, setModel] = useState<ActiveModel | null>(null);
  const [killedMidRead, setKilledMidRead] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const list = await listGames(db);
    const keys = new Set<string>();
    for (const g of list) for (const s of [g.home, g.away]) if (s.name?.trim()) keys.add(teamKey(s.name));
    setColors(await teamColors(db, [...keys]));
    setAll(list);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      (async () => {
        const current = await activeModel(db);
        const interrupted = (await getSetting(db, READ_IN_PROGRESS_KEY)) !== null;
        await load();
        if (!live) return;
        setModel(current);
        setKilledMidRead(interrupted);
      })();
      return () => {
        live = false;
      };
    }, [db, load]),
  );

  const seasons = useMemo(() => [...new Set(all.map((g) => g.season))].sort().reverse(), [all]);
  // Default to the season of the last game scanned: a misread year (2077) must not win.
  const latest = useMemo(() => [...all].sort((a, b) => b.createdAt - a.createdAt)[0], [all]);
  const shown = season ?? latest?.season ?? seasonFor(null);
  const games = useMemo(() => all.filter((g) => g.season === shown), [all, shown]);
  const table = useMemo(() => standings(games), [games]);
  const toCheck = useMemo(() => games.filter((g) => validateGame(g).length > 0).length, [games]);

  const openTeam = (key: string) => router.push({ pathname: '/team/[key]', params: { key, season: shown } });

  const chooseSeason = () =>
    dialog.actions(
      'Season',
      seasons.map((s) => ({ label: s, hint: `${all.filter((g) => g.season === s).length} games`, onPress: () => setSeason(s) })),
    );

  const more = () =>
    dialog.actions('More', [
      { label: 'Sync', hint: 'Your games and templates on all your devices', onPress: () => setSyncing(true) },
      { label: 'Account', hint: 'Sign in, groups and invite links', onPress: () => router.push('/account') },
      { label: 'Season stats and export', hint: 'Every player, CSV', onPress: () => router.push('/season') },
      { label: 'Appearance', hint: THEME_LABEL[getThemePreference()], onPress: chooseTheme },
      { label: 'Advanced', hint: 'Scoresheet templates, reading model', onPress: openAdvanced },
    ]);

  // Rarely needed: scans recognise the scoresheet and only ask to set one up when it's new.
  const openAdvanced = () =>
    dialog.actions('Advanced', [
      { label: 'Scoresheet templates', hint: 'See, fix or build them part by part', onPress: () => router.push('/templates') },
      { label: 'Reading model', hint: model?.name, onPress: () => router.push('/models') },
    ]);

  const chooseTheme = () => {
    const current = getThemePreference();
    dialog.actions(
      'Appearance',
      (['system', 'light', 'dark'] as const).map((t) => ({
        label: `${t === current ? '✓  ' : ''}${THEME_LABEL[t]}`,
        onPress: () => setThemePreference(t),
      })),
    );
  };

  const remove = async (game: Game) => {
    const home = teamScore(game.home);
    const away = teamScore(game.away);
    const ok = await dialog.confirm({
      title: 'Delete this game?',
      subject: {
        label: `${game.home.name ?? 'Home'} vs ${game.away.name ?? 'Away'}`,
        value: home !== null && away !== null ? `${home}–${away}` : undefined,
      },
      body: 'The box score and both page photos go. Your templates stay.',
      confirm: 'Delete game',
      cancel: 'Keep it',
      destructive: true,
    });
    if (!ok) return;
    await deleteGame(db, game.id);
    setAll((list) => list.filter((g) => g.id !== game.id));
    // Photos go only once the undo has passed, so Undo can bring the game back whole.
    let undone = false;
    const purge = setTimeout(() => {
      if (!undone) deleteGameImages(game.id);
    }, 6000);
    dialog.toast({
      text: 'Game deleted',
      duration: 5500,
      action: {
        label: 'Undo',
        onPress: () => {
          undone = true;
          clearTimeout(purge);
          // Undo also drops the sync tombstone, or the next sync would delete it again.
          void clearTombstone(db, game.id)
            .then(() => saveGame(db, game))
            .then(load);
        },
      },
    });
  };

  const needsModel = model && !model.ready;

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.header }}>
        <View style={styles.header}>
          <View style={styles.between}>
            {/* Development builds: hold the logo to open the test bench. */}
            <Pressable onLongPress={__DEV__ ? () => router.push('/bench') : undefined} accessible={false}>
              <View style={[styles.logoChip, { backgroundColor: c.bg }]}>
                <LogoMark size={22} />
              </View>
            </Pressable>
            <Pressable
              onPress={seasons.length > 1 ? chooseSeason : undefined}
              accessibilityRole={seasons.length > 1 ? 'button' : 'text'}
              accessibilityLabel={`Season ${shown}${seasons.length > 1 ? ', change' : ''}`}
              style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
              <Text style={[styles.title, { color: c.headerText }]}>My games</Text>
              <Text style={[styles.subtitle, { color: c.headerText }]}>
                {`Basketball · ${shown}${seasons.length > 1 ? '  ▾' : ''}`}
              </Text>
            </Pressable>
            <Pressable onPress={() => setSyncing(true)} accessibilityRole="button" accessibilityLabel="Sync" style={styles.iconButton}>
              <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.headerText} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-1 8.5" />
                <Path d="M12 12v8M9 15l3-3 3 3" />
              </Svg>
            </Pressable>
          </View>
          <HeaderTabs
            color={c.headerText}
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'standings', label: 'Standings' },
              { key: 'scores', label: 'Scores' },
              { key: 'leaders', label: 'Leaders' },
            ]}
          />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={[base.content, { paddingHorizontal: space.md, paddingBottom: 120 }]}>
        {killedMidRead && (
          <Card style={{ backgroundColor: c.errorBg, borderColor: c.error }}>
            <T style={[base.h2, { color: c.error }]}>Reading was interrupted</T>
            <T>
              Android closed InkStat while it was reading a page, almost always because the phone ran low on memory.
              Close other apps and try again.
              {model?.approxRamBytes ? ` ${model.name} needs about ${(model.approxRamBytes / 1e9).toFixed(1)} GB free.` : ''}
            </T>
            <Button
              title="OK"
              kind="secondary"
              onPress={() => {
                setKilledMidRead(false);
                void clearSetting(db, READ_IN_PROGRESS_KEY);
              }}
            />
          </Card>
        )}
        {needsModel && (
          <Card style={{ backgroundColor: c.warnBg, borderColor: c.warnLine }}>
            <T style={base.h2}>Download the reading model</T>
            <T>
              InkStat reads scoresheets entirely on this phone. It needs a one-time download of {model.name} first. Use
              Wi-Fi.
            </T>
            <Button title="Set up model" onPress={() => router.push('/models')} />
          </Card>
        )}
        {toCheck > 0 && tab !== 'scores' && (
          <Pressable
            onPress={() => setTab('scores')}
            accessibilityRole="button"
            style={[styles.strip, { backgroundColor: c.warnBg, borderLeftColor: c.warnLine }]}>
            <T style={{ flex: 1, fontSize: 14 }}>
              <Text style={{ fontFamily: fonts.bodyBold }}>{`${toCheck} game${toCheck === 1 ? '' : 's'}`}</Text>
              {` ${toCheck === 1 ? 'has' : 'have'} things to check.`}
            </T>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Review</T>
          </Pressable>
        )}

        {tab === 'standings' && <StandingsTable rows={table} colors={colors} onTeam={openTeam} gameCount={games.length} />}
        {tab === 'scores' && <Scores games={games} onDelete={remove} />}
        {tab === 'leaders' && <Leaders games={games} colors={colors} onTeam={openTeam} />}
      </ScrollView>

      {/* Bottom bar: the scan button sits in the middle, raised. */}
      <SafeAreaView edges={['bottom']} style={[styles.bottom, { backgroundColor: c.card, borderTopColor: c.border }]}>
        <View style={styles.bottomRow}>
          <Pressable style={styles.bottomItem} onPress={() => setTab('standings')} accessibilityRole="button">
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth={2} strokeLinecap="round">
              <Path d="M4 6h16M4 12h16M4 18h16M9 4v16" />
            </Svg>
            <Text style={[styles.bottomLabel, { color: c.accent }]}>Standings</Text>
          </Pressable>
          <Pressable
            style={styles.bottomItem}
            onPress={() => router.push(needsModel ? '/models' : '/scan')}
            accessibilityRole="button"
            accessibilityLabel="Scan a game">
            <View style={[styles.fab, { backgroundColor: c.accent }]}>
              <Svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke={c.accentText} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
                <Path d="M7 12h10" />
              </Svg>
            </View>
            <Text style={[styles.bottomLabel, { color: c.text }]}>Scan a game</Text>
          </Pressable>
          <Pressable style={styles.bottomItem} onPress={more} accessibilityRole="button">
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.muted} strokeWidth={2} strokeLinecap="round">
              <Path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3.5} />
            </Svg>
            <Text style={[styles.bottomLabel, { color: c.muted }]}>More</Text>
          </Pressable>
        </View>
      </SafeAreaView>
      <SyncSheet visible={syncing} onClose={() => setSyncing(false)} onSynced={() => void load()} />
    </View>
  );
}

const COLS = { rank: 20, w: 28, l: 30, pct: 46, gb: 32, l10: 42, strk: 40 };

function StandingsTable({
  rows,
  colors,
  onTeam,
  gameCount,
}: {
  rows: StandingRow[];
  colors: Record<string, string>;
  onTeam: (key: string) => void;
  gameCount: number;
}) {
  const c = useColors();
  if (!rows.length) {
    return (
      <Card>
        <T style={base.h2}>No standings yet</T>
        <T muted>
          Scan a game and the table builds itself: every team you keep the book for, with wins, losses, the last 10 and
          streaks.
        </T>
        <Button title="Scan a game" onPress={() => router.push('/scan')} />
      </Card>
    );
  }
  const head = (label: string, width: number) => (
    <Text style={[styles.th, { width, color: c.muted }]}>{label}</Text>
  );
  const num = (v: string | number, width: number, color = c.text, bold = false) => (
    <Text style={[styles.td, { width, color, fontFamily: bold ? fonts.monoBold : fonts.mono }]}>{v}</Text>
  );
  return (
    <View style={{ gap: space.sm }}>
      <View style={[styles.table, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={[styles.tr, styles.thRow, { borderBottomColor: c.text }]}>
          <Text style={{ width: COLS.rank }} />
          <Text style={[styles.th, { flex: 1, textAlign: 'left', color: c.muted }]}>TEAM</Text>
          {head('W', COLS.w)}
          {head('L', COLS.l)}
          {head('PCT', COLS.pct)}
          {head('GB', COLS.gb)}
          {head('L10', COLS.l10)}
          {head('STRK', COLS.strk)}
        </View>
        {rows.map((r, i) => {
          const l10w = r.lastTen.filter((x) => x === 'W').length;
          return (
            <Pressable
              key={r.key}
              onPress={() => onTeam(r.key)}
              accessibilityRole="button"
              accessibilityLabel={`${i + 1}. ${r.name}, ${r.wins} wins, ${r.losses} losses, last 10 ${l10w} and ${r.lastTen.length - l10w}, streak ${r.streak ? `${r.streak.kind === 'W' ? 'won' : 'lost'} ${r.streak.count}` : 'none'}`}
              style={({ pressed }) => [
                styles.tr,
                { minHeight: 52, backgroundColor: pressed ? c.sunken : 'transparent' },
                i < rows.length - 1 && { borderBottomWidth: 1, borderBottomColor: c.sunken },
              ]}>
              <Text style={[styles.td, { width: COLS.rank, textAlign: 'left', color: c.muted }]}>{i + 1}</Text>
              <View style={[base.row, { flex: 1, minWidth: 0 }]}>
                <TeamBadge name={r.name} color={colors[r.key] ?? c.muted} />
                <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.bodySemiBold, fontSize: 15, color: c.text }}>
                  {r.name}
                </Text>
              </View>
              {num(r.wins, COLS.w, c.text, true)}
              {num(r.losses, COLS.l)}
              {num(formatPct(r.pct), COLS.pct, c.muted)}
              {num(formatGamesBehind(r.gamesBehind), COLS.gb, c.muted)}
              {num(`${l10w}-${r.lastTen.length - l10w}`, COLS.l10)}
              {num(r.streak ? `${r.streak.kind}${r.streak.count}` : '–', COLS.strk, r.streak?.kind === 'L' ? c.error : c.ok, true)}
            </Pressable>
          );
        })}
      </View>
      <T muted style={[base.small, { paddingHorizontal: space.xs }]}>
        {`From ${gameCount} game${gameCount === 1 ? '' : 's'} you scanned. Tap a team for its games, players and stats.`}
      </T>
    </View>
  );
}

function Scores({ games, onDelete }: { games: Game[]; onDelete: (g: Game) => void }) {
  if (!games.length) return <T muted>No games yet. Scan a scorebook page to get started.</T>;
  return (
    <View style={{ gap: space.sm + 2 }}>
      <T muted style={base.small}>Press and hold a game to delete it.</T>
      {games.map((g) => (
        <GameRow key={g.id} game={g} onDelete={() => onDelete(g)} />
      ))}
    </View>
  );
}

function Leaders({ games, colors, onTeam }: { games: Game[]; colors: Record<string, string>; onTeam: (key: string) => void }) {
  const c = useColors();
  const lines = useMemo(() => seasonTotals(games).slice(0, 15), [games]);
  if (!lines.length) return <T muted>Leaders appear once you have scanned a game.</T>;
  return (
    <View style={[styles.table, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={[styles.tr, styles.thRow, { borderBottomColor: c.text }]}>
        <Text style={[styles.th, { flex: 1, textAlign: 'left', color: c.muted }]}>POINTS PER GAME</Text>
        <Text style={[styles.th, { width: 30, color: c.muted }]}>GP</Text>
        <Text style={[styles.th, { width: 48, color: c.text }]}>PPG</Text>
      </View>
      {lines.map((p, i) => (
        <Pressable
          key={p.key}
          onPress={() => onTeam(teamKey(p.team))}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.tr,
            { minHeight: 50, backgroundColor: pressed ? c.sunken : 'transparent' },
            i < lines.length - 1 && { borderBottomWidth: 1, borderBottomColor: c.sunken },
          ]}>
          <Text style={[styles.td, { width: 22, textAlign: 'left', color: c.muted }]}>{i + 1}</Text>
          <View style={[base.row, { flex: 1, minWidth: 0 }]}>
            <TeamBadge name={p.team} color={colors[teamKey(p.team)] ?? c.muted} size={22} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontFamily: fonts.bodySemiBold, fontSize: 15, color: c.text }}>
                {`${p.number ? `#${p.number} ` : ''}${p.name ?? 'Unnamed'}`}
              </Text>
              <Text style={{ fontFamily: fonts.body, fontSize: 12, color: c.muted }}>{p.team}</Text>
            </View>
          </View>
          <Text style={[styles.td, { width: 30, color: c.muted }]}>{p.games}</Text>
          <Text style={[styles.td, { width: 48, fontFamily: fonts.monoBold, color: c.text }]}>{perGame(p.points, p.games)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function GameRow({ game, onDelete }: { game: Game; onDelete: () => void }) {
  const issues = validateGame(game);
  const errors = issues.filter((i) => i.severity === 'error').length;
  // Only one team's page was read and the other team's score isn't in yet.
  const waiting = teamScore(game.home) === null || teamScore(game.away) === null;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })}
      onLongPress={onDelete}
      accessibilityRole="button"
      accessibilityHint="Press and hold to delete"
      accessibilityActions={[{ name: 'delete', label: 'Delete game' }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === 'delete' && onDelete()}>
      <Card style={styles.gameRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <T style={{ fontFamily: fonts.bodySemiBold, fontSize: 16 }}>
            {game.away.name ?? 'Away'} @ {game.home.name ?? 'Home'}
          </T>
          <T muted style={base.small}>{game.date ?? 'No date'}</T>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <T style={[base.num, { fontSize: 17 }]}>
            {teamScore(game.away) ?? '–'}–{teamScore(game.home) ?? '–'}
          </T>
          {errors > 0 ? (
            <Badge tone="error" label={`${errors} error${errors === 1 ? '' : 's'}`} />
          ) : issues.length > 0 ? (
            <Badge tone="warn" label={`${issues.length} to check`} />
          ) : waiting ? (
            <Badge tone="waiting" label="Waiting for scores" />
          ) : (
            <Badge tone="ok" label="Checked" />
          )}
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.xs },
  between: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  logoChip: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.bodyBold, fontSize: 18 },
  subtitle: { fontFamily: fonts.body, fontSize: 12.5, opacity: 0.75 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  strip: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderLeftWidth: 4, borderRadius: 4, paddingHorizontal: space.md, minHeight: 44 },
  table: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 2 },
  thRow: { minHeight: 34, borderBottomWidth: 2 },
  th: { fontFamily: fonts.monoBold, fontSize: 11, textAlign: 'right' },
  td: { fontFamily: fonts.mono, fontSize: 14, textAlign: 'right' },
  gameRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: 1 },
  bottomRow: { flexDirection: 'row', height: 64, alignItems: 'flex-end', paddingBottom: 6 },
  bottomItem: { flex: 1, alignItems: 'center', gap: 2, minHeight: 48, justifyContent: 'flex-end' },
  bottomLabel: { fontFamily: fonts.bodySemiBold, fontSize: 11.5 },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -30,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
});
