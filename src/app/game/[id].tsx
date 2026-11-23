import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { clearTombstone, deleteGame, saveGame } from '@/db';
import { gameToCsv, gameToJson, teamScore, validateGame, wasRead, type Game, type Side } from '@inkstat/basketball';
import { deleteGameImages, shareText } from '@/lib/files';
import { sideName, useGame } from '@/lib/useGame';
import { T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { EditSheet } from '@/ui/EditSheet';
import { base, fonts, radius, space, useColors } from '@/ui/theme';

const SIDES: Side[] = ['home', 'away'];

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function GameSummary() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const c = useColors();
  const dialog = useDialog();
  const { game, update } = useGame(id);
  const [editing, setEditing] = useState(false);
  const issues = useMemo(() => (game ? validateGame(game) : []), [game]);

  if (!game) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  const share = async (kind: 'csv' | 'json') => {
    const name = `${game.date ?? 'game'}-${game.home.name ?? 'home'}-vs-${game.away.name ?? 'away'}`
      .replace(/[^a-z0-9-]+/gi, '_')
      .toLowerCase();
    try {
      if (kind === 'csv') await shareText(`${name}.csv`, gameToCsv(game), 'text/csv');
      else await shareText(`${name}.json`, gameToJson(game), 'application/json');
    } catch (e) {
      void dialog.notice('Could not share', e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    const h = teamScore(game.home);
    const a = teamScore(game.away);
    const ok = await dialog.confirm({
      title: 'Delete this game?',
      subject: { label: `${sideName(game, 'home')} vs ${sideName(game, 'away')}`, value: h !== null && a !== null ? `${h}–${a}` : undefined },
      body: 'The box score and both page photos go. Your templates stay.',
      confirm: 'Delete game',
      cancel: 'Keep it',
      destructive: true,
    });
    if (!ok) return;
    const copy: Game = game;
    await deleteGame(db, copy.id);
    let undone = false;
    const purge = setTimeout(() => !undone && deleteGameImages(copy.id), 6000);
    router.back();
    dialog.toast({
      text: 'Game deleted',
      duration: 5500,
      action: {
        label: 'Undo',
        onPress: () => {
          undone = true;
          clearTimeout(purge);
          void clearTombstone(db, copy.id).then(() => saveGame(db, copy));
        },
      },
    });
  };

  const more = () =>
    dialog.actions('This game', [
      { label: 'Edit date and place', onPress: () => setEditing(true) },
      { label: 'Export CSV', hint: 'For a spreadsheet', onPress: () => void share('csv') },
      { label: 'Export JSON', onPress: () => void share('json') },
      { label: 'Delete game', destructive: true, onPress: () => void remove() },
    ]);

  const periods = Math.max(4, game.home.periodScores.length, game.away.periodScores.length);
  const winner: Side | null = (() => {
    const h = teamScore(game.home);
    const a = teamScore(game.away);
    return h === null || a === null || h === a ? null : h > a ? 'home' : 'away';
  })();
  const when = [formatDate(game.date), game.location].filter(Boolean).join(' · ');
  // A side whose page wasn't read and whose score isn't in yet: the other scorekeeper's scan, or a typed score, fills it.
  const waitingFor = SIDES.find((s) => !wasRead(game[s]) && teamScore(game[s]) === null) ?? null;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Game',
          headerRight: () => (
            <Pressable onPress={more} accessibilityRole="button" accessibilityLabel="Export, edit or delete" style={styles.headerButton}>
              <Svg width={22} height={22} viewBox="0 0 24 24" fill={c.text}>
                <Path d="M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" />
              </Svg>
            </Pressable>
          ),
        }}
      />
      <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={[base.content, { gap: space.md }]}>
        {/* Scoreboard */}
        <View accessibilityLabel="Final score" style={[styles.board, { backgroundColor: c.card, borderColor: c.text }]}>
          <View style={styles.between}>
            <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityHint="Edit date and place" style={{ flex: 1 }}>
              <T muted style={{ fontSize: 13 }}>{when || 'Add date and place'}</T>
            </Pressable>
            <T muted style={{ fontSize: 13, fontFamily: fonts.bodyBold, letterSpacing: 0.6 }}>FINAL</T>
          </View>
          {SIDES.map((s, i) => (
            <View key={s}>
              {i === 1 && <View style={{ height: 1, backgroundColor: c.border, marginBottom: 8 }} />}
              <View style={styles.teamLine}>
                <T style={{ flex: 1, fontSize: 22, fontFamily: winner === s || !winner ? fonts.bodyBold : fonts.bodySemiBold, color: winner && winner !== s ? c.muted : c.text }}>
                  {sideName(game, s)}
                </T>
                <T muted style={{ fontSize: 12, fontFamily: fonts.bodySemiBold }}>{s === 'home' ? 'HOME' : 'AWAY'}</T>
                {waitingFor === s ? (
                  <T muted style={{ fontSize: 14, fontFamily: fonts.bodySemiBold, minWidth: 60, textAlign: 'right' }}>Waiting</T>
                ) : (
                  <T style={{ fontSize: 34, fontFamily: fonts.monoBold, minWidth: 60, textAlign: 'right', color: winner && winner !== s ? c.muted : c.text }}>
                    {teamScore(game[s]) ?? '–'}
                  </T>
                )}
              </View>
            </View>
          ))}
        </View>

        {waitingFor && (
          <View style={[styles.flag, { backgroundColor: c.sunken }]}>
            <T style={{ fontSize: 16, fontFamily: fonts.bodyBold }}>Waiting for scores</T>
            <T style={{ fontSize: 14, lineHeight: 20 }}>
              {`Only one team’s page was read. ${game[waitingFor].name ? `${game[waitingFor].name}’s` : 'The other team’s'} score fills in when their scorekeeper scans their page, or you can add it.`}
            </T>
            <Pressable
              onPress={() => router.push({ pathname: '/game/box', params: { id: game.id, side: waitingFor, edit: 'team' } })}
              accessibilityRole="button"
              style={[styles.smallButton, { borderWidth: 1.5, borderColor: c.accent }]}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 15 }}>Add the score myself</T>
            </Pressable>
          </View>
        )}

        {/* Check before it counts */}
        {issues.length > 0 ? (
          <View style={[styles.flag, { backgroundColor: c.warnBg }]}>
            <T style={{ fontSize: 16, fontFamily: fonts.bodyBold, color: c.warn }}>
              {issues.length === 1 ? '1 thing to check before this game counts' : `${issues.length} things to check before this game counts`}
            </T>
            <T style={{ fontSize: 14, lineHeight: 20 }}>Each one shows the part of the page InkStat read it from, so you can compare in seconds.</T>
            <Pressable
              onPress={() => router.push({ pathname: '/game/check', params: { id: game.id } })}
              accessibilityRole="button"
              style={[styles.smallButton, { backgroundColor: c.accent }]}>
              <T style={{ color: c.accentText, fontFamily: fonts.bodySemiBold, fontSize: 15 }}>Check now  ›</T>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.flag, { backgroundColor: c.okBg }]}>
            <T style={{ fontSize: 15, fontFamily: fonts.bodySemiBold, color: c.ok }}>✓ Everything adds up</T>
          </View>
        )}

        {/* Line score */}
        <View accessibilityLabel="Score by quarter">
          <T style={[styles.rule, { borderColor: c.text }]}>SCORE BY QUARTER</T>
          <View style={styles.lineRow}>
            <View style={{ flex: 1 }} />
            {Array.from({ length: periods }, (_, i) => (
              <T key={i} muted style={styles.lineHead}>{i < 4 ? `Q${i + 1}` : `OT${i - 3}`}</T>
            ))}
            <T muted style={[styles.lineHead, { width: 44, textAlign: 'right' }]}>T</T>
          </View>
          {SIDES.map((s) => (
            <View key={s} style={[styles.lineRow, { borderTopWidth: 1, borderColor: c.border, paddingVertical: 8 }]}>
              <T style={{ flex: 1, fontFamily: fonts.bodySemiBold }} >{sideName(game, s)}</T>
              {Array.from({ length: periods }, (_, i) => (
                <T key={i} style={styles.lineCell}>{game[s].periodScores[i] ?? '–'}</T>
              ))}
              <T style={[styles.lineCell, { width: 44, textAlign: 'right', fontFamily: fonts.monoBold }]}>{teamScore(game[s]) ?? '–'}</T>
            </View>
          ))}
        </View>

        {/* Leaders, per team */}
        {SIDES.filter((s) => game[s].players.length > 0).map((s) => {
          const top = [...game[s].players]
            .filter((p) => p.points !== null)
            .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
            .slice(0, 3);
          if (!top.length) return null;
          return (
            <View key={s}>
              <T style={[styles.rule, { borderColor: c.text }]}>{`${sideName(game, s).toUpperCase()} LEADERS`}</T>
              <View style={{ flexDirection: 'row' }}>
                {top.map((p, i) => (
                  <View key={i} style={{ flex: 1, paddingTop: 10, gap: 2 }}>
                    <T style={{ fontSize: 24, fontFamily: fonts.monoBold }}>{p.points}</T>
                    <T style={{ fontSize: 14, fontFamily: fonts.bodySemiBold }}>{p.name ?? `#${p.number ?? '?'}`}</T>
                    <T muted style={{ fontSize: 12.5 }}>{[p.number ? `#${p.number}` : null, p.fouls !== null ? `${p.fouls} foul${p.fouls === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</T>
                  </View>
                ))}
              </View>
            </View>
          );
        })}

        <Pressable
          onPress={() => router.push({ pathname: '/game/box', params: { id: game.id } })}
          accessibilityRole="button"
          style={[styles.outline, { borderColor: c.accent }]}>
          <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 15 }}>Full box score · both teams  ›</T>
        </Pressable>
      </ScrollView>

      <EditSheet
        visible={editing}
        title="Date and place"
        fields={editing ? [
          { key: 'date', label: 'Date', value: game.date ?? '', placeholder: 'yyyy-mm-dd', flex: 1 },
          { key: 'location', label: 'Played at', value: game.location ?? '', flex: 2 },
        ] : []}
        onClose={() => setEditing(false)}
        onSave={(d) => {
          setEditing(false);
          void update((g) => ({ ...g, date: d.date.trim() || null, location: d.location.trim() || null }));
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  board: { borderWidth: 1.5, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  teamLine: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  flag: { borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  smallButton: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 16, borderRadius: radius.md, justifyContent: 'center', marginTop: 2 },
  rule: { fontSize: 13, fontFamily: fonts.bodyBold, letterSpacing: 0.8, borderBottomWidth: 2, paddingBottom: 4 },
  lineRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 6 },
  lineHead: { width: 36, textAlign: 'center', fontSize: 12, fontFamily: fonts.bodyBold },
  lineCell: { width: 36, textAlign: 'center', fontFamily: fonts.mono, fontSize: 15 },
  outline: { minHeight: 48, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: space.sm },
});
