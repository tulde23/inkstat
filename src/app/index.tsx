import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import {
  READ_IN_PROGRESS_KEY,
  clearSetting,
  clearTombstone,
  currentTeam,
  deleteGame,
  getSetting,
  listGames,
  listTeams,
  saveGame,
  setCurrentTeam,
} from '@/db';
import {
  myPlayers,
  myResult,
  perGame,
  seasonFor,
  teamSeason,
  validateGame,
  type Game,
  type MyResult,
  type MyTeam,
} from '@inkstat/basketball';
import { activeModel, type ActiveModel } from '@/engine/host';
import { Badge, Button, Card, T } from '@/ui/components';
import { deleteGameImages } from '@/lib/files';
import { LogoMark } from '@/ui/Logo';
import { SyncSheet } from '@/ui/SyncSheet';
import { useDialog } from '@/ui/Dialog';
import { useLightStatusBar } from '@/ui/useLightStatusBar';
import { THEME_LABEL, getThemePreference, setThemePreference } from '@/ui/themePreference';
import { base, fonts, space, useColors } from '@/ui/theme';

/** Games shown before "All". */
const RECENT = 5;

/**
 * Home is your team: its record, its games and its leaders, with a big Scan button
 * at the bottom. The first time, it asks which team you keep the book for.
 */
export default function Home() {
  const db = useSQLiteContext();
  const c = useColors();
  const dialog = useDialog();
  useLightStatusBar();
  const [all, setAll] = useState<Game[]>([]);
  const [team, setTeam] = useState<MyTeam | null>(null);
  const [teams, setTeams] = useState<MyTeam[]>([]);
  const [season, setSeason] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [model, setModel] = useState<ActiveModel | null>(null);
  const [killedMidRead, setKilledMidRead] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const [list, mine, every] = await Promise.all([listGames(db), currentTeam(db), listTeams(db)]);
    setAll(list);
    setTeams(every);
    setTeam(mine);
    return mine;
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      (async () => {
        const current = await activeModel(db);
        const interrupted = (await getSetting(db, READ_IN_PROGRESS_KEY)) !== null;
        const mine = await load();
        if (!live) return;
        // First run: whose book is this?
        if (!mine) return router.replace('/team-setup');
        setModel(current);
        setKilledMidRead(interrupted);
      })();
      return () => {
        live = false;
      };
    }, [db, load]),
  );

  const teamGames = useMemo(() => (team ? all.filter((g) => g.teamId === team.id) : []), [all, team]);
  const seasons = useMemo(() => [...new Set(teamGames.map((g) => g.season))].sort().reverse(), [teamGames]);
  // Default to the season of the last game scanned: a misread year (2077) must not win.
  const latest = useMemo(() => [...teamGames].sort((a, b) => b.createdAt - a.createdAt)[0], [teamGames]);
  const shown = season && seasons.includes(season) ? season : (latest?.season ?? seasonFor(null));
  const games = useMemo(() => teamGames.filter((g) => g.season === shown), [teamGames, shown]);
  const record = useMemo(() => (team ? teamSeason(games, team.id) : null), [games, team]);
  const leaders = useMemo(
    () => (team ? [...myPlayers(games, team)].sort((a, b) => perGame(b.points, b.games) - perGame(a.points, a.games)).slice(0, 3) : []),
    [games, team],
  );
  // Scanned before there were teams, or "this game isn't ours": not on the record.
  const unlinked = useMemo(() => all.filter((g) => !g.teamId), [all]);
  const toCheck = useMemo(() => games.filter((g) => validateGame(g).length > 0), [games]);

  const chooseSeason = () =>
    dialog.actions(
      'Season',
      seasons.map((s) => ({ label: s, hint: `${teamGames.filter((g) => g.season === s).length} games`, onPress: () => setSeason(s) })),
    );

  const switchTeam = () =>
    dialog.actions('Your teams', [
      ...teams.map((t) => ({
        label: `${t.id === team?.id ? '●  ' : ''}${t.name}`,
        onPress: () => {
          setSeason(null);
          void setCurrentTeam(db, t.id).then(load);
        },
      })),
      { label: '+ Add a team', onPress: () => router.push('/team-setup?add=1') },
    ]);

  const openUnlinked = () =>
    dialog.actions(
      'Games not on your record',
      unlinked.slice(0, 12).map((g) => ({
        label: `${g.home.name ?? 'Home'} vs ${g.away.name ?? 'Away'}`,
        hint: g.date ?? undefined,
        onPress: () => router.push({ pathname: '/game/whose', params: { id: g.id } }),
      })),
      'Tap a game to say which team is yours.',
    );

  const remove = async (game: Game) => {
    const r = myResult(game);
    const ok = await dialog.confirm({
      title: 'Delete this game?',
      subject: {
        label: r?.opponent ? `vs ${r.opponent}` : `${game.home.name ?? 'Home'} vs ${game.away.name ?? 'Away'}`,
        value: r && r.us !== null && r.them !== null ? `${r.us}–${r.them}` : undefined,
      },
      body: 'The box score and the page photos go. Your templates stay.',
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

  const needsModel = model && !model.ready;
  const results = record?.results ?? [];
  const listed = showAll ? results : results.slice(0, RECENT);
  const streak = record?.streak;

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
            <View style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
              <Pressable
                onPress={teams.length > 1 ? switchTeam : () => router.push('/team-edit')}
                accessibilityRole="button"
                accessibilityLabel={`${team?.name ?? 'Your team'}, ${teams.length > 1 ? 'switch team' : 'edit team'}`}>
                <Text numberOfLines={1} style={[styles.title, { color: c.headerText }]}>
                  {`${team?.name ?? ''}${teams.length > 1 ? '  ▾' : ''}`}
                </Text>
              </Pressable>
              <Pressable
                onPress={seasons.length > 1 ? chooseSeason : undefined}
                accessibilityRole={seasons.length > 1 ? 'button' : 'text'}
                accessibilityLabel={`Season ${shown}${seasons.length > 1 ? ', change' : ''}`}>
                <Text style={[styles.subtitle, { color: c.headerText }]}>{`${shown} season${seasons.length > 1 ? '  ▾' : ''}`}</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => router.push('/team-edit')} accessibilityRole="button" accessibilityLabel="Edit team" style={styles.iconButton}>
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={c.headerText} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
              </Svg>
            </Pressable>
            <Pressable onPress={() => setSyncing(true)} accessibilityRole="button" accessibilityLabel="Sync" style={styles.iconButton}>
              <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.headerText} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-1 8.5" />
                <Path d="M12 12v8M9 15l3-3 3 3" />
              </Svg>
            </Pressable>
          </View>
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
        <View style={styles.tiles}>
          <Card style={styles.tile}>
            <T muted style={styles.tileLabel}>Record</T>
            <Text style={[styles.tileValue, { color: c.text }]}>
              {record ? `${record.wins}–${record.losses}${record.ties ? `–${record.ties}` : ''}` : '0–0'}
            </Text>
            <T style={[styles.tileNote, { color: streak ? (streak.kind === 'W' ? c.ok : streak.kind === 'L' ? c.error : c.muted) : c.muted }]}>
              {streak
                ? streak.count > 1
                  ? `${streak.kind === 'W' ? 'Won' : streak.kind === 'L' ? 'Lost' : 'Tied'} ${streak.count} in a row`
                  : `${streak.kind === 'W' ? 'Won' : streak.kind === 'L' ? 'Lost' : 'Tied'} the last game`
                : 'No results yet'}
            </T>
          </Card>
          <Card style={styles.tile}>
            <T muted style={styles.tileLabel}>Points a game</T>
            <Text style={[styles.tileValue, { color: c.text }]}>{record?.pointsFor ? String(record.pointsFor) : '–'}</Text>
            <T muted style={styles.tileNote}>{record?.pointsAgainst ? `allowed ${record.pointsAgainst}` : ' '}</T>
          </Card>
        </View>

        {toCheck.length > 0 && (
          <Pressable
            onPress={() => router.push({ pathname: '/game/[id]', params: { id: toCheck[0].id } })}
            accessibilityRole="button"
            style={[styles.strip, { backgroundColor: c.warnBg, borderLeftColor: c.warnLine }]}>
            <T style={{ flex: 1, fontSize: 14 }}>
              <Text style={{ fontFamily: fonts.bodyBold }}>{`${toCheck.length} game${toCheck.length === 1 ? '' : 's'}`}</Text>
              {` ${toCheck.length === 1 ? 'has' : 'have'} things to check.`}
            </T>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Review</T>
          </Pressable>
        )}

        <Card style={styles.list}>
          <View style={styles.listHead}>
            <T style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 16 }}>Games</T>
            {results.length > RECENT && (
              <Pressable onPress={() => setShowAll((v) => !v)} accessibilityRole="button" hitSlop={8}>
                <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 14 }}>
                  {showAll ? 'Fewer' : `All ${results.length}`}
                </T>
              </Pressable>
            )}
          </View>
          {listed.length === 0 && (
            <T muted style={{ paddingHorizontal: 14, paddingBottom: 14 }}>No games yet. Tap Scan a game after your next game.</T>
          )}
          {listed.map((r) => (
            <ResultRow key={r.game.id} result={r} onDelete={() => void remove(r.game)} />
          ))}
        </Card>
        {listed.length > 0 && <T muted style={base.small}>Press and hold a game to delete it.</T>}

        {leaders.length > 0 && (
          <Card style={styles.list}>
            <View style={styles.listHead}>
              <T style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 16 }}>Team leaders · points a game</T>
              <Pressable onPress={() => router.push('/season')} accessibilityRole="button" hitSlop={8}>
                <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 14 }}>Season stats</T>
              </Pressable>
            </View>
            {leaders.map((p, i) => (
              <View key={p.key} style={[styles.leader, { borderTopColor: c.border }]}>
                <Text style={[styles.rank, { color: c.muted }]}>{i + 1}</Text>
                <T style={{ flex: 1, fontSize: 15 }}>{`${p.number ? `#${p.number} ` : ''}${p.name ?? ''}`.trim() || 'Unnamed'}</T>
                <Text style={[styles.value, { color: c.text }]}>{perGame(p.points, p.games)}</Text>
              </View>
            ))}
          </Card>
        )}

        {unlinked.length > 0 && (
          <Pressable onPress={openUnlinked} accessibilityRole="button" style={styles.unlinked}>
            <T muted style={{ flex: 1, fontSize: 14 }}>
              {`${unlinked.length} scanned game${unlinked.length === 1 ? ' isn’t' : 's aren’t'} on your record`}
            </T>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 14 }}>Sort out</T>
          </Pressable>
        )}
      </ScrollView>

      {/* Bottom bar: the scan button sits in the middle, raised. */}
      <SafeAreaView edges={['bottom']} style={[styles.bottom, { backgroundColor: c.card, borderTopColor: c.border }]}>
        <View style={styles.bottomRow}>
          <Pressable style={styles.bottomItem} onPress={() => router.push('/season')} accessibilityRole="button">
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth={2} strokeLinecap="round">
              <Path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
            </Svg>
            <Text style={[styles.bottomLabel, { color: c.accent }]}>Season</Text>
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

function ResultRow({ result, onDelete }: { result: MyResult; onDelete: () => void }) {
  const c = useColors();
  const { game, us, them, opponent, outcome } = result;
  const issues = validateGame(game).length;
  const tone = outcome === 'W' ? c.ok : outcome === 'L' ? c.error : c.muted;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })}
      onLongPress={onDelete}
      accessibilityRole="button"
      accessibilityLabel={`${outcome === 'W' ? 'Win' : outcome === 'L' ? 'Loss' : outcome === 'T' ? 'Tie' : 'Game'} against ${opponent ?? 'opponent'}`}
      style={({ pressed }) => [styles.result, { borderTopColor: c.border, backgroundColor: pressed ? c.sunken : 'transparent' }]}>
      <View style={[styles.outcome, { backgroundColor: outcome ? tone : c.sunken }]}>
        <Text style={{ color: outcome ? '#fff' : c.muted, fontFamily: fonts.bodyBold, fontSize: 15 }}>{outcome ?? '–'}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontFamily: fonts.bodySemiBold, color: c.text }}>{`vs ${opponent ?? 'Opponent'}`}</Text>
        <View style={[base.row, { gap: 6 }]}>
          <T muted style={{ fontSize: 13 }}>{`${game.date ?? 'No date'}${game.mine ? ` · ${game.mine}` : ''}`}</T>
          {them === null ? <Badge tone="waiting" label="Waiting for score" /> : issues > 0 ? <Badge tone="warn" label={`${issues} to check`} /> : null}
        </View>
      </View>
      <Text style={[styles.value, { color: c.text, fontSize: 17 }]}>{us !== null && them !== null ? `${us}–${them}` : us !== null ? String(us) : ''}</Text>
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
  tiles: { flexDirection: 'row', gap: space.sm },
  tile: { flex: 1, gap: 2 },
  tileLabel: { fontSize: 13 },
  tileValue: { fontFamily: fonts.monoBold, fontSize: 32, lineHeight: 38 },
  tileNote: { fontSize: 13, fontFamily: fonts.bodySemiBold },
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  listHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 44 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, minHeight: 60 },
  outcome: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  leader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 44, borderTopWidth: 1 },
  rank: { width: 16, fontFamily: fonts.monoBold, fontSize: 13 },
  value: { fontFamily: fonts.monoBold, fontSize: 15 },
  unlinked: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 },
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
