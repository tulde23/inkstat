import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { validateGame, type Game, type Issue, type PlayerLine } from '@inkstat/basketball';
import { parseIssuePath, photosFor, sideName, teamPhotos, useGame } from '@/lib/useGame';
import { Button, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { PhotoViewer } from '@/ui/PhotoViewer';
import { base, fonts, radius, space, useColors } from '@/ui/theme';

const FIELD_NAME: Record<string, string> = {
  points: 'total points',
  fouls: 'fouls',
  ftMade: 'free throws made',
  ftAttempted: 'free throws tried',
  fg2: '2-point baskets',
  fg3: '3-point baskets',
  number: 'number',
  totalPoints: 'final score',
  periodScores: 'score by quarter',
};

function kindOf(i: Issue): string {
  if (/add up|adds up/.test(i.message)) return "Doesn't add up";
  if (/appears twice/.test(i.message)) return 'Read twice?';
  if (/missing|no number|no points/.test(i.message)) return 'Missing';
  if (/limit/.test(i.message)) return 'Over the limit';
  return 'Check this';
}

const toInt = (s: string): number | null => {
  const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/** What the user is editing for one issue: one number, the quarters, or a number+name. */
type Draft = { value: string; quarters: string[]; number: string; name: string };

/** Team numbers a check can correct one at a time (quarters are edited together). */
const TEAM_NUMBERS = ['totalPoints', 'runningScore', 'halfScore'] as const;
type TeamNumber = (typeof TEAM_NUMBERS)[number];
const isTeamNumber = (f: string): f is TeamNumber => (TEAM_NUMBERS as readonly string[]).includes(f);

function draftFor(g: Game, i: Issue): Draft {
  const p = parseIssuePath(i.path);
  const team = g[p.side];
  const row = p.kind === 'player' ? team.players[p.row] : null;
  const v =
    p.kind === 'player' ? row?.[p.field as keyof PlayerLine] : isTeamNumber(p.field) ? team[p.field] : null;
  return {
    value: typeof v === 'number' ? String(v) : '',
    quarters: team.periodScores.map((s) => (s === null ? '' : String(s))),
    number: row?.number ?? '',
    name: row?.name ?? '',
  };
}

function apply(g: Game, i: Issue, d: Draft): Game {
  const p = parseIssuePath(i.path);
  const team = g[p.side];
  if (p.kind === 'player') {
    const patch: Partial<PlayerLine> =
      p.field === 'number' ? { number: d.number.trim() || null, name: d.name.trim() || null } : { [p.field]: toInt(d.value) };
    return { ...g, [p.side]: { ...team, players: team.players.map((r, k) => (k === p.row ? { ...r, ...patch } : r)) } };
  }
  if (p.field === 'periodScores') return { ...g, [p.side]: { ...team, periodScores: d.quarters.map(toInt) } };
  if (isTeamNumber(p.field)) return { ...g, [p.side]: { ...team, [p.field]: toInt(d.value) } };
  return g;
}

export default function CheckFlow() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const dialog = useDialog();
  const { game, update } = useGame(id);
  // The list is fixed when the flow opens, so fixing one does not reshuffle the rest.
  const [list, setList] = useState<Issue[] | null>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  if (game && list === null) {
    const all = validateGame(game);
    setList(all);
    if (all[0]) setDraft(draftFor(game, all[0]));
  }
  if (!game || !list) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  const finish = (g: Game) => {
    router.back();
    const left = validateGame(g).length;
    dialog.toast({ text: left ? `${left} still to check. Open the box score to fix them.` : 'All checked. This game counts.' });
  };
  const issue = list[step];
  if (!issue || !draft) {
    return (
      <SafeAreaView style={[base.screen, { backgroundColor: c.bg, padding: space.lg, gap: space.md, justifyContent: 'center' }]}>
        <T style={{ fontSize: 22, fontFamily: fonts.bodyBold }}>Nothing to check</T>
        <Button title="Back to the game" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const p = parseIssuePath(issue.path);
  const team = game[p.side];
  const row = p.kind === 'player' ? team.players[p.row] : null;
  const who = row ? [row.number ? `#${row.number}` : null, row.name].filter(Boolean).join(' ') || `Row ${(p.row ?? 0) + 1}` : sideName(game, p.side);
  const photos = teamPhotos(team);
  const shown = photosFor(team, issue);
  const candidate = apply(game, issue, draft);
  const stillThere = validateGame(candidate).some((x) => x.path === issue.path);
  const changed = JSON.stringify(candidate) !== JSON.stringify(game);
  const readAs = draftFor(game, issue).value;

  const go = (next: number, g: Game = game) => {
    if (next >= list.length) return finish(g);
    setStep(next);
    setDraft(draftFor(g, list[next]));
  };
  const save = async () => {
    if (changed) await update((g) => apply(g, issue, draft));
    go(step + 1, candidate);
  };

  const numeric = !(p.kind === 'player' && p.field === 'number') && p.field !== 'periodScores';

  return (
    <SafeAreaView style={[base.screen, { backgroundColor: c.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Close" style={styles.icon}>
          <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={c.text} strokeWidth={2.2} strokeLinecap="round">
            <Path d="M6 6l12 12M18 6L6 18" />
          </Svg>
        </Pressable>
        <T style={{ flex: 1, fontSize: 17, fontFamily: fonts.bodySemiBold }}>{`Check ${step + 1} of ${list.length}`}</T>
        <Pressable onPress={() => go(step + 1)} accessibilityRole="button" style={styles.skip}>
          <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Skip</T>
        </Pressable>
      </View>
      <View style={styles.progress}>
        {list.map((_, k) => (
          <View key={k} style={[styles.seg, { backgroundColor: k <= step ? c.accent : c.border }]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 4 }}>
          <T style={{ fontSize: 13, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: c.warn }}>{kindOf(issue).toUpperCase()}</T>
          <T style={{ fontSize: 24, fontFamily: fonts.bodyBold }}>{`${who}, ${FIELD_NAME[p.field] ?? p.field}`}</T>
          <T muted style={{ fontSize: 15, lineHeight: 21 }}>{issue.message}</T>
        </View>

        {shown.length > 0 && (
          <View style={{ gap: 6 }}>
            <T muted style={styles.caption}>{`ON THE PAGE · ${photos[shown[0]].label.toUpperCase()}`}</T>
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {shown.map((k) => (
                <Pressable key={k} onPress={() => setViewing(k)} accessibilityRole="imagebutton" accessibilityLabel={`Zoom ${photos[k].label}`}>
                  <Image source={{ uri: photos[k].uri }} style={[styles.crop, { borderColor: c.border, backgroundColor: c.sunken, width: shown.length > 1 ? 280 : 358 }]} resizeMode="contain" />
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.photoBar}>
              <T muted style={{ fontSize: 12.5, flex: 1 }}>Tap to zoom.</T>
              {team.pageUri && !(shown.length === 1 && shown[0] === 0) && (
                <Pressable
                  onPress={() => setViewing(0)}
                  accessibilityRole="button"
                  accessibilityHint="Opens the whole page photo; pinch to zoom"
                  style={styles.wholePage}>
                  <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 14 }}>See the whole page</T>
                </Pressable>
              )}
            </View>
          </View>
        )}

        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          {numeric ? (
            <>
              <T muted style={{ fontSize: 14 }}>
                {'InkStat read '}
                <T style={{ color: c.error, fontFamily: fonts.monoBold }}>{readAs || 'nothing'}</T>
                . What does the page say?
              </T>
              <View style={styles.stepper}>
                <StepButton label="One less" sign="−" c={c} onPress={() => setDraft({ ...draft, value: String(Math.max(0, (toInt(draft.value) ?? 0) - 1)) })} />
                <TextInput
                  value={draft.value}
                  onChangeText={(v) => setDraft({ ...draft, value: v })}
                  keyboardType="number-pad"
                  selectTextOnFocus
                  accessibilityLabel={FIELD_NAME[p.field] ?? p.field}
                  style={[styles.big, { color: c.text, borderColor: c.text, backgroundColor: c.card }]}
                />
                <StepButton label="One more" sign="+" c={c} onPress={() => setDraft({ ...draft, value: String((toInt(draft.value) ?? 0) + 1) })} />
              </View>
            </>
          ) : p.field === 'periodScores' ? (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {draft.quarters.map((q, k) => (
                <View key={k} style={{ gap: 4, flexGrow: 1, flexBasis: 60 }}>
                  <T muted style={{ fontSize: 13, fontFamily: fonts.bodySemiBold }}>{k < 4 ? `Q${k + 1}` : `OT${k - 3}`}</T>
                  <TextInput
                    value={q}
                    onChangeText={(v) => setDraft({ ...draft, quarters: draft.quarters.map((x, j) => (j === k ? v : x)) })}
                    keyboardType="number-pad"
                    selectTextOnFocus
                    style={[styles.small, { color: c.text, borderColor: c.border }]}
                  />
                </View>
              ))}
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ width: 80, gap: 4 }}>
                <T muted style={{ fontSize: 13, fontFamily: fonts.bodySemiBold }}>No.</T>
                <TextInput value={draft.number} onChangeText={(v) => setDraft({ ...draft, number: v })} keyboardType="number-pad" style={[styles.small, { color: c.text, borderColor: c.border }]} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <T muted style={{ fontSize: 13, fontFamily: fonts.bodySemiBold }}>Player</T>
                <TextInput value={draft.name} onChangeText={(v) => setDraft({ ...draft, name: v })} style={[styles.small, { color: c.text, borderColor: c.border, fontFamily: fonts.bodySemiBold, textAlign: 'left' }]} />
              </View>
            </View>
          )}
          {changed && (
            <T style={{ fontSize: 14, fontFamily: fonts.bodySemiBold, color: stillThere ? c.warn : c.ok }}>
              {stillThere ? 'Still does not add up with this.' : 'That clears it ✓'}
            </T>
          )}
          {p.field === 'totalPoints' && (
            <Pressable onPress={() => router.replace({ pathname: '/game/box', params: { id: game.id, side: p.side } })} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>A player row is wrong instead? Open the box score ›</T>
            </Pressable>
          )}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={{ flex: 1 }}>
          <Button title="It's right as read" kind="secondary" onPress={() => go(step + 1)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={changed ? `Save${numeric ? ` ${draft.value}` : ''} · next` : 'Next'} onPress={() => void save()} />
        </View>
      </View>
      <PhotoViewer photos={photos} index={viewing} onClose={() => setViewing(null)} />
    </SafeAreaView>
  );
}

function StepButton({ label, sign, onPress, c }: { label: string; sign: string; onPress: () => void; c: ReturnType<typeof useColors> }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={[styles.step, { borderColor: c.accent }]}>
      <T style={{ color: c.accent, fontSize: 24, fontFamily: fonts.monoBold }}>{sign}</T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 8 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  skip: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  progress: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 4 },
  seg: { flex: 1, height: 5, borderRadius: 3 },
  caption: { fontSize: 12.5, fontFamily: fonts.bodyBold, letterSpacing: 0.5 },
  crop: { height: 150, borderRadius: radius.sm, borderWidth: 1 },
  photoBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wholePage: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  card: { borderWidth: 1, borderRadius: radius.md, padding: 14, gap: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { width: 52, height: 52, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  big: { flex: 1, height: 52, borderWidth: 1.5, borderRadius: radius.md, textAlign: 'center', fontSize: 28, fontFamily: fonts.monoBold },
  small: { minHeight: 48, borderWidth: 1.5, borderRadius: radius.md, textAlign: 'center', fontSize: 18, fontFamily: fonts.monoBold, paddingHorizontal: 10 },
  footer: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 },
});
