import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { teamScore, validateGame, type Issue, type PlayerLine, type Side, type TeamSheet } from '@inkstat/basketball';
import { photosFor, sideName, teamPhotos, useGame } from '@/lib/useGame';
import { T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { EditSheet, type SheetField } from '@/ui/EditSheet';
import { PhotoViewer } from '@/ui/PhotoViewer';
import { base, fonts, radius, space, useColors } from '@/ui/theme';

const EXTRA: { key: 'fg2' | 'fg3' | 'ftMade' | 'ftAttempted'; label: string }[] = [
  { key: 'fg2', label: '2-pt baskets' },
  { key: 'fg3', label: '3-pt baskets' },
  { key: 'ftMade', label: 'Free throws made' },
  { key: 'ftAttempted', label: 'Free throws tried' },
];

const blankPlayer = (): PlayerLine => ({
  number: null, name: null, fouls: null, fg2: null, fg3: null, ftMade: null, ftAttempted: null, points: null, readNotes: [],
});

const toInt = (s: string | undefined): number | null => {
  const n = parseInt((s ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const sumPts = (ps: PlayerLine[]) => ps.reduce((n, p) => n + (p.points ?? 0), 0);

type Editing = { kind: 'row'; index: number } | { kind: 'team' } | null;

export default function BoxScore() {
  const { id, side: start, edit } = useLocalSearchParams<{ id: string; side?: Side; edit?: 'team' }>();
  const c = useColors();
  const dialog = useDialog();
  const { game, update } = useGame(id);
  const [side, setSide] = useState<Side>(start === 'away' ? 'away' : 'home');
  const [editing, setEditing] = useState<Editing>(edit === 'team' ? { kind: 'team' } : null);
  const [viewing, setViewing] = useState<number | null>(null);
  const issues = useMemo(() => (game ? validateGame(game) : []), [game]);

  if (!game) return <View style={[base.screen, { backgroundColor: c.bg }]} />;
  const team = game[side];
  const flagAt = (path: string): Issue | undefined => issues.find((i) => i.path === `${side}.${path}`);
  const extras = EXTRA.filter((e) => team.players.some((p) => p[e.key] !== null));
  const totalFlag = flagAt('totalPoints');
  const photos = teamPhotos(team);

  const setTeam = (fn: (t: TeamSheet) => TeamSheet) => update((g) => ({ ...g, [side]: fn(g[side]) }));

  const removeRow = async (index: number) => {
    const p = team.players[index];
    const who = [p.number ? `#${p.number}` : null, p.name].filter(Boolean).join(' ') || `Row ${index + 1}`;
    const ok = await dialog.confirm({
      title: 'Remove this row?',
      subject: { label: who, value: p.points !== null ? `${p.points} pts` : undefined },
      body: 'Use this for a row InkStat read twice or a line that is not a player.',
      confirm: 'Remove row',
      cancel: 'Keep it',
      destructive: true,
    });
    if (!ok) return;
    setEditing(null);
    await setTeam((t) => ({ ...t, players: t.players.filter((_, k) => k !== index) }));
    dialog.toast({
      text: `Removed ${who}`,
      action: {
        label: 'Undo',
        onPress: () => void setTeam((t) => ({ ...t, players: [...t.players.slice(0, index), p, ...t.players.slice(index)] })),
      },
    });
  };

  // The sheet being edited
  const row = editing?.kind === 'row' ? team.players[editing.index] : null;
  const rowPath = editing?.kind === 'row' ? `players.${editing.index}` : '';
  const rowFlags = row ? issues.filter((i) => i.path.startsWith(`${side}.${rowPath}.`)) : [];
  const flagged = (field: string) => rowFlags.find((i) => i.path.endsWith(`.${field}`));
  const rowPhoto = row
    ? photosFor(team, rowFlags[0] ?? { severity: 'warning', path: `${side}.${rowPath}.points`, message: '' })[0]
    : undefined;
  const fields: SheetField[] = row
    ? [
        { key: 'number', label: 'No.', value: row.number ?? '', numeric: true, flex: 0, flag: flagged('number') ? 'check' : undefined },
        { key: 'name', label: 'Player', value: row.name ?? '', flex: 3 },
        { key: 'points', label: 'Points', value: str(row.points), numeric: true, flag: flagged('points') ? `read ${str(row.points) || 'blank'}` : undefined },
        { key: 'fouls', label: 'Fouls', value: str(row.fouls), numeric: true, flag: flagged('fouls') ? 'check' : undefined },
        ...extras.map((e) => ({ key: e.key, label: e.label, value: str(row[e.key]), numeric: true })),
      ]
    : editing?.kind === 'team'
      ? [
          { key: 'name', label: 'Team', value: team.name ?? '', flex: 2 },
          { key: 'coach', label: 'Coach', value: team.coach ?? '', flex: 2 },
          ...team.periodScores.map((s, i) => ({ key: `q${i}`, label: i < 4 ? `Q${i + 1}` : `OT${i - 3}`, value: str(s), numeric: true })),
          { key: 'total', label: 'Final', value: str(team.totalPoints), numeric: true, flag: totalFlag ? 'check' : undefined },
          { key: 'timeouts', label: 'Timeouts used', value: str(team.timeoutsUsed), numeric: true },
          ...(team.teamFouls?.length ? team.teamFouls : [null, null]).map((f, i, all) => ({
            key: `tf${i}`, label: all.length === 2 ? `Team fouls, half ${i + 1}` : `Team fouls ${i + 1}`, value: str(f), numeric: true,
          })),
        ]
      : [];

  return (
    <>
      <Stack.Screen options={{ title: 'Box score' }} />
      <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={[base.content, { gap: space.md }]}>
        <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: c.sunken }]}>
          {(['home', 'away'] as const).map((s) => {
            const selected = s === side;
            const n = issues.filter((i) => i.path.startsWith(`${s}.`)).length;
            return (
              <Pressable
                key={s}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setSide(s)}
                style={[styles.tab, selected && { backgroundColor: c.card, borderColor: c.border }]}>
                <T style={{ fontFamily: fonts.bodySemiBold, color: selected ? c.text : c.muted }}>{sideName(game, s)}</T>
                <T style={{ fontFamily: fonts.monoBold, fontSize: 14, color: selected ? c.text : c.muted }}>{teamScore(game[s]) ?? '–'}</T>
                {n > 0 && <View style={[styles.dot, { backgroundColor: c.warnLine }]} />}
              </Pressable>
            );
          })}
        </View>

        <View>
          <View style={[styles.row, styles.head, { borderColor: c.text }]}>
            <T muted style={[styles.th, { width: 40 }]}>NO.</T>
            <T muted style={[styles.th, { flex: 1 }]}>PLAYER</T>
            <T muted style={[styles.th, { width: 52, textAlign: 'right' }]}>PTS</T>
            <T muted style={[styles.th, { width: 40, textAlign: 'right' }]}>F</T>
          </View>
          {team.players.map((p, i) => {
            const pf = flagAt(`players.${i}.points`);
            const any = issues.some((x) => x.path.startsWith(`${side}.players.${i}.`));
            return (
              <Pressable
                key={i}
                onPress={() => setEditing({ kind: 'row', index: i })}
                accessibilityRole="button"
                accessibilityLabel={`${p.number ? `Number ${p.number}, ` : ''}${p.name ?? 'no name'}, ${p.points ?? 'no'} points, ${p.fouls ?? 'no'} fouls${any ? ', needs a check' : ''}`}
                style={({ pressed }) => [
                  styles.row,
                  { borderColor: c.border, minHeight: 46, backgroundColor: any ? c.warnBg + '66' : pressed ? c.sunken : 'transparent' },
                ]}>
                <T muted style={{ width: 40, fontFamily: fonts.mono, fontSize: 14 }}>{p.number ?? '–'}</T>
                <View style={{ flex: 1 }}>
                  <T style={{ fontFamily: fonts.bodySemiBold }}>{p.name ?? 'No name'}</T>
                  {p.readNotes.length > 0 && <T muted style={{ fontSize: 12 }}>{p.readNotes.join('; ')}</T>}
                </View>
                <View style={{ width: 52, alignItems: 'flex-end' }}>
                  <T style={[styles.num, pf && { color: c.error, backgroundColor: c.errorBg, borderColor: c.error, borderWidth: 1.5 }]}>{p.points ?? '–'}</T>
                </View>
                <T style={{ width: 40, textAlign: 'right', fontFamily: fonts.mono }}>{p.fouls ?? '–'}</T>
              </Pressable>
            );
          })}
          <View style={[styles.row, { borderTopWidth: 2, borderBottomWidth: 0, borderColor: c.text, minHeight: 46 }]}>
            <View style={{ width: 40 }} />
            <T style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 14 }}>Team total</T>
            <T style={{ width: 52, textAlign: 'right', fontFamily: fonts.monoBold, fontSize: 16, color: totalFlag ? c.error : c.text }}>{sumPts(team.players)}</T>
            <T style={{ width: 40, textAlign: 'right', fontFamily: fonts.monoBold }}>{team.players.reduce((n, p) => n + (p.fouls ?? 0), 0)}</T>
          </View>
          {totalFlag && <T style={{ color: c.warn, fontSize: 13, lineHeight: 19 }}>{totalFlag.message}. Tap the row that looks wrong.</T>}
          <Pressable onPress={() => {
            void setTeam((t) => ({ ...t, players: [...t.players, blankPlayer()] }));
            setEditing({ kind: 'row', index: team.players.length });
          }} accessibilityRole="button" style={styles.add}>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>+ Add a player</T>
          </Pressable>
        </View>

        <Pressable onPress={() => setEditing({ kind: 'team' })} accessibilityRole="button" accessibilityHint="Edit team name, coach, quarters, timeouts and team fouls" style={styles.cards}>
          <Stat label="Coach" value={team.coach || 'Not read'} missing={!team.coach} c={c} />
          <Stat label="Timeouts" value={team.timeoutsUsed !== null ? `${team.timeoutsUsed} used` : 'Not read'} missing={team.timeoutsUsed === null} c={c} />
          <Stat
            label="Team fouls"
            value={team.teamFouls?.some((f) => f !== null) ? team.teamFouls.map((f) => f ?? '–').join(' / ') : 'Not read'}
            missing={!team.teamFouls?.some((f) => f !== null)}
            c={c}
          />
          <Stat label="Quarters" value={team.periodScores.map((s) => s ?? '–').join(' ')} missing={team.periodScores.some((s) => s === null)} c={c} />
        </Pressable>

        <T muted style={{ textAlign: 'center', fontSize: 13 }}>Tap a row, or the cards above, to fix it next to the page.</T>
      </ScrollView>

      <EditSheet
        visible={editing !== null && (editing.kind === 'team' || row !== null)}
        title={editing?.kind === 'team' ? `${sideName(game, side)} details` : 'Edit row'}
        image={editing?.kind === 'row' && rowPhoto !== undefined ? photos[rowPhoto]?.uri : editing?.kind === 'team' ? photos[photosFor(team, { severity: 'warning', path: `${side}.periodScores`, message: '' })[0]]?.uri : null}
        imageLabel={editing?.kind === 'row' && rowPhoto !== undefined ? photos[rowPhoto]?.label : 'On the page'}
        onImage={() => setViewing(editing?.kind === 'row' ? rowPhoto ?? 0 : 0)}
        fields={fields}
        footnote={
          editing?.kind === 'row' && team.totalPoints !== null
            ? (d) => {
                const sum = sumPts(team.players.map((p, k) => (k === editing.index ? { ...p, points: toInt(d.points) } : p)));
                return sum === team.totalPoints
                  ? { text: `With ${d.points || 0}, player points add up to ${sum} ✓`, ok: true }
                  : { text: `With ${d.points || 0}, players add up to ${sum} of ${team.totalPoints}`, ok: false };
              }
            : undefined
        }
        remove={editing?.kind === 'row' ? { label: 'Remove row', onPress: () => void removeRow(editing.index) } : undefined}
        onClose={() => setEditing(null)}
        onSave={(d) => {
          const e = editing;
          setEditing(null);
          if (e?.kind === 'row') {
            void setTeam((t) => ({
              ...t,
              players: t.players.map((p, k) =>
                k !== e.index
                  ? p
                  : {
                      ...p,
                      number: d.number?.trim() || null,
                      name: d.name?.trim() || null,
                      points: toInt(d.points),
                      fouls: toInt(d.fouls),
                      ...Object.fromEntries(extras.map((x) => [x.key, toInt(d[x.key])])),
                    },
              ),
            }));
          } else if (e?.kind === 'team') {
            void setTeam((t) => ({
              ...t,
              name: d.name?.trim() || null,
              coach: d.coach?.trim() || null,
              periodScores: t.periodScores.map((_, i) => toInt(d[`q${i}`])),
              totalPoints: toInt(d.total),
              timeoutsUsed: toInt(d.timeouts),
              teamFouls: (t.teamFouls?.length ? t.teamFouls : [null, null]).map((_, i) => toInt(d[`tf${i}`])),
            }));
          }
        }}
      />
      <PhotoViewer photos={photos} index={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

function Stat({ label, value, missing, c }: { label: string; value: string; missing: boolean; c: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.card, missing ? { backgroundColor: c.warnBg } : { backgroundColor: c.card, borderColor: c.border, borderWidth: 1 }]}>
      <T style={{ fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.5, color: missing ? c.warn : c.muted }}>{label.toUpperCase()}</T>
      <T style={{ fontSize: 15, fontFamily: missing ? fonts.bodySemiBold : fonts.monoBold }}>{missing && value === 'Not read' ? 'Not read · add' : value}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderRadius: radius.lg, padding: 4, gap: 4 },
  tab: { flex: 1, minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, borderBottomWidth: 1 },
  head: { borderBottomWidth: 2, paddingBottom: 5 },
  th: { fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.6 },
  num: { fontFamily: fonts.monoBold, fontSize: 16, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3, overflow: 'hidden' },
  add: { minHeight: 48, justifyContent: 'center' },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { flexBasis: '47%', flexGrow: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
});
