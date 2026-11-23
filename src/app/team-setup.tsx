import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listGames, listTeams, saveGame, saveTeam, setCurrentTeam } from '@/db';
import { claimGames, nameKey, sheetNames, type MyTeam } from '@inkstat/basketball';
import { Button, T } from '@/ui/components';
import { base, fonts, radius, space, useColors } from '@/ui/theme';

const newId = () => `team-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * First run, and "Add a team": which team do you keep the book for? The name is free
 * text. Names from games already scanned are offered, so those games count as this team's.
 */
export default function TeamSetup() {
  const db = useSQLiteContext();
  const c = useColors();
  const adding = useLocalSearchParams<{ add?: string }>().add === '1';
  const [name, setName] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [games, teams] = await Promise.all([listGames(db), listTeams(db)]);
      // Names another team already goes by aren't offered again.
      const taken = new Set(teams.flatMap((t) => [t.name, ...t.aliases]).map(nameKey));
      setSuggestions(sheetNames(games.filter((g) => !g.teamId)).filter((n) => !taken.has(nameKey(n))).slice(0, 6));
    })();
  }, [db]);

  const pick = (n: string) => {
    const on = picked === n ? null : n;
    setPicked(on);
    // A tapped sheet name fills an empty team name; the user can make it nicer.
    if (on && !name.trim()) setName(on);
  };

  const save = async () => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    setBusy(true);
    const now = Date.now();
    const team: MyTeam = {
      id: newId(),
      name: clean,
      aliases: picked && nameKey(picked) !== nameKey(clean) ? [picked] : [],
      createdAt: now,
      updatedAt: now,
    };
    await saveTeam(db, team);
    await setCurrentTeam(db, team.id);
    for (const g of claimGames(await listGames(db), team, now)) await saveGame(db, g);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <SafeAreaView edges={adding ? ['bottom'] : ['top', 'bottom']} style={[base.screen, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: 'Add a team', headerShown: adding }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[base.content, { paddingTop: adding ? space.lg : space.xl }]} keyboardShouldPersistTaps="handled">
          {!adding && <T muted style={{ fontSize: 15, fontFamily: fonts.bodySemiBold }}>Welcome to InkStat</T>}
          <T style={base.h1}>Which team do you keep the book for?</T>
          <T muted style={styles.body}>
            InkStat keeps your team’s record, box scores and leaders. Call it whatever you like; you can change it any time.
          </T>
          <View style={{ gap: 6 }}>
            <T muted style={styles.label}>Team name</T>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Beacon Hill JV Girls 2026"
              placeholderTextColor={c.muted}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              accessibilityLabel="Team name"
              style={[styles.input, { color: c.text, borderColor: c.text, backgroundColor: c.card }]}
            />
          </View>
          {suggestions.length > 0 && (
            <View style={{ gap: 8 }}>
              <T muted style={styles.label}>From games you’ve already scanned</T>
              <View style={styles.chips}>
                {suggestions.map((n) => {
                  const on = picked === n;
                  return (
                    <Pressable
                      key={n}
                      onPress={() => pick(n)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      style={[styles.chip, { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : c.card }]}>
                      <T style={{ color: on ? c.accentText : c.text, fontFamily: fonts.bodySemiBold, fontSize: 14 }}>{n}</T>
                    </Pressable>
                  );
                })}
              </View>
              <T muted style={{ fontSize: 13.5, lineHeight: 19 }}>
                Tap the name your team goes by on the scoresheet, so those games count as yours.
              </T>
            </View>
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Button title="Continue" onPress={() => void save()} disabled={!name.trim()} busy={busy} />
          {!adding && (
            <T muted style={{ textAlign: 'center', fontSize: 13 }}>Keep books for two teams? Add the other one later from the team menu.</T>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15.5, lineHeight: 22 },
  label: { fontSize: 13, fontFamily: fonts.bodySemiBold },
  input: { minHeight: 52, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 17, fontFamily: fonts.bodySemiBold },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, justifyContent: 'center' },
  footer: { padding: space.lg, gap: space.sm },
});
