import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { currentTeam, getGame, saveGame, saveTeam } from '@/db';
import { assignGame, learnName, opponentScore, other, type Game, type MyTeam, type Side } from '@inkstat/basketball';
import { Button, Card, T } from '@/ui/components';
import { base, fonts, radius, space, useColors } from '@/ui/theme';

const sideLabel = (game: Game, side: Side) =>
  game[side].name?.trim() || (side === 'home' ? 'The home team' : 'The away team');

/**
 * Right after a scan, only when needed: "Which team is yours?" (no name on the sheet
 * matches your team yet) and "What did they score?" (the sheet had no opponent score).
 * Then on to the game.
 */
export default function Whose() {
  const db = useSQLiteContext();
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [game, setGame] = useState<Game | null>(null);
  const [team, setTeam] = useState<MyTeam | null>(null);
  const [score, setScore] = useState('');

  const toGame = () => router.replace({ pathname: '/game/[id]', params: { id } });

  useEffect(() => {
    void (async () => {
      const [g, t] = await Promise.all([getGame(db, id), currentTeam(db)]);
      if (!g || !t || (g.mine && opponentScore(g[other(g.mine)]) !== null)) return toGame();
      setGame(g);
      setTeam(t);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, id]);

  if (!game || !team) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  const choose = async (side: Side) => {
    const learned = learnName(team, game[side].name);
    if (learned !== team) await saveTeam(db, learned);
    const next = assignGame(game, learned, side);
    await saveGame(db, next);
    if (opponentScore(next[other(side)]) === null) {
      setTeam(learned);
      setGame(next);
    } else toGame();
  };

  const saveScore = async () => {
    const n = Number(score);
    if (!game.mine || !Number.isInteger(n) || n < 0 || n > 999) return;
    const them = other(game.mine);
    await saveGame(db, { ...game, [them]: { ...game[them], totalPoints: n }, updatedAt: Date.now() });
    toGame();
  };

  // Step 1: which side is yours.
  if (!game.mine) {
    return (
      <SafeAreaView edges={['bottom']} style={[base.screen, { backgroundColor: c.bg }]}>
        <Stack.Screen options={{ title: 'Which team is yours?' }} />
        <ScrollView contentContainerStyle={base.content}>
          <T style={base.h1}>Which team is yours?</T>
          <T muted style={styles.body}>{`Neither name on this scoresheet matches ${team.name} yet.`}</T>
          {(['home', 'away'] as const).map((s) => (
            <Button key={s} title={sideLabel(game, s)} kind="secondary" onPress={() => void choose(s)} />
          ))}
          <T muted style={{ fontSize: 13.5, lineHeight: 19 }}>
            InkStat remembers your answer, so it won’t ask about that name again.
          </T>
        </ScrollView>
        <View style={styles.footer}>
          <Button title="Neither: this game isn’t ours" kind="secondary" onPress={toGame} />
        </View>
      </SafeAreaView>
    );
  }

  // Step 2: the opponent's score.
  const opponent = sideLabel(game, other(game.mine));
  const us = opponentScore(game[game.mine]);
  const them = score.trim() === '' ? null : Number(score);
  const outcome = us === null || them === null || !Number.isFinite(them) ? null : us > them ? 'W' : us < them ? 'L' : 'T';
  const tone = outcome === 'W' ? c.ok : outcome === 'L' ? c.error : c.muted;

  return (
    <SafeAreaView edges={['bottom']} style={[base.screen, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: 'Their score' }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={base.content} keyboardShouldPersistTaps="handled">
          {us !== null && (
            <Card>
              <T style={{ fontFamily: fonts.bodyBold, fontSize: 17 }}>{`${team.name} ${us}`}</T>
            </Card>
          )}
          <T style={base.h1}>{`What did ${opponent} score?`}</T>
          <T muted style={styles.body}>Only your team’s score was on the scoresheet, so InkStat needs theirs for the win or loss.</T>
          <TextInput
            value={score}
            onChangeText={(v) => setScore(v.replace(/[^0-9]/g, '').slice(0, 3))}
            keyboardType="number-pad"
            autoFocus
            placeholder="0"
            placeholderTextColor={c.muted}
            accessibilityLabel={`${opponent} final score`}
            onSubmitEditing={() => void saveScore()}
            style={[styles.big, { color: c.text, borderColor: c.text, backgroundColor: c.card }]}
          />
          {outcome && (
            <View style={[styles.result, { borderColor: tone }]}>
              <View style={[styles.badge, { backgroundColor: tone }]}>
                <T style={{ color: '#fff', fontFamily: fonts.bodyBold }}>{outcome}</T>
              </View>
              <T style={{ fontSize: 16, fontFamily: fonts.bodySemiBold }}>
                {`${outcome === 'W' ? 'Win' : outcome === 'L' ? 'Loss' : 'Tie'}, ${us}–${them}`}
              </T>
            </View>
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Button title="Save the game" onPress={() => void saveScore()} disabled={them === null} />
          <Button title="I don’t know it yet" kind="secondary" onPress={toGame} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15.5, lineHeight: 22 },
  footer: { padding: space.lg, gap: space.sm },
  big: { minHeight: 64, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 30, fontFamily: fonts.monoBold },
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.lg, borderWidth: 1.5 },
  badge: { width: 30, height: 30, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
});
