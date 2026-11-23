import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { currentTeam, deleteTeam, listGames, saveTeam } from '@/db';
import { learnName, type MyTeam } from '@inkstat/basketball';
import { deleteGameImages } from '@/lib/files';
import { Card, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { EditSheet } from '@/ui/EditSheet';
import { base, fonts, radius, space, useColors } from '@/ui/theme';

const stamp = (team: MyTeam): MyTeam => ({ ...team, updatedAt: Date.now() });

/** The team's name (yours to choose) and the names it goes by on the scoresheet. */
export default function TeamEdit() {
  const db = useSQLiteContext();
  const c = useColors();
  const dialog = useDialog();
  const [team, setTeam] = useState<MyTeam | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void currentTeam(db).then((t) => {
        setTeam(t);
        setName(t?.name ?? '');
      });
    }, [db]),
  );

  /** Saves a change to the team, stamped now. */
  async function update(change: MyTeam) {
    const next = stamp(change);
    setTeam(next);
    await saveTeam(db, next);
  }

  const saveName = () => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!team) return;
    if (!clean) return setName(team.name);
    if (clean !== team.name) void update({ ...team, name: clean });
  };

  const removeAlias = (alias: string) => {
    if (team) void update({ ...team, aliases: team.aliases.filter((a) => a !== alias) });
  };

  const remove = async () => {
    if (!team) return;
    const games = (await listGames(db)).filter((g) => g.teamId === team.id);
    const ok = await dialog.confirm({
      title: 'Delete this team?',
      subject: { label: team.name, value: `${games.length} game${games.length === 1 ? '' : 's'}` },
      body: 'Its games, box scores and page photos are deleted from this phone. This can’t be undone.',
      confirm: 'Delete team',
      destructive: true,
    });
    if (!ok) return;
    await deleteTeam(db, team.id);
    for (const g of games) deleteGameImages(g.id);
    router.replace('/');
  };

  if (!team) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  return (
    <>
      <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={base.content} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6 }}>
          <T muted style={styles.label}>Team name</T>
          <TextInput
            value={name}
            onChangeText={setName}
            onBlur={saveName}
            onSubmitEditing={saveName}
            returnKeyType="done"
            autoCapitalize="words"
            accessibilityLabel="Team name"
            style={[styles.input, { color: c.text, borderColor: c.text, backgroundColor: c.card }]}
          />
          <T muted style={{ fontSize: 13 }}>Shown on your home screen, box scores and exports.</T>
        </View>

        <View style={{ gap: 8, marginTop: space.sm }}>
          <T style={base.h2}>Names on the scoresheet</T>
          <View style={styles.chips}>
            {team.aliases.map((a) => (
              <Pressable
                key={a}
                onPress={() => removeAlias(a)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${a}`}
                style={[styles.chip, { borderColor: c.border, backgroundColor: c.card }]}>
                <T style={{ fontFamily: fonts.bodySemiBold, fontSize: 14 }}>{a}</T>
                <T muted style={{ fontSize: 15 }}>✕</T>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setAdding(true)}
              accessibilityRole="button"
              style={[styles.chip, { borderColor: c.accent, backgroundColor: c.card }]}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 14 }}>+ Add</T>
            </Pressable>
          </View>
          <T muted style={{ fontSize: 13.5, lineHeight: 19 }}>
            How scorekeepers write your team. InkStat uses these to find your team on a scanned page, and learns new ones when
            you tell it which team is yours. Tap one to remove it if it was learned by mistake.
          </T>
        </View>

        <Card style={{ padding: 0, gap: 0, marginTop: space.sm }}>
          <Pressable onPress={() => router.push('/team-setup?add=1')} accessibilityRole="button" style={styles.row}>
            <T style={{ flex: 1, fontSize: 15.5 }}>Add another team</T>
            <T muted>›</T>
          </Pressable>
          <Pressable onPress={() => void remove()} accessibilityRole="button" style={[styles.row, { borderTopWidth: 1, borderTopColor: c.border }]}>
            <T style={{ flex: 1, fontSize: 15.5, color: c.error }}>Delete this team and its games</T>
          </Pressable>
        </Card>
      </ScrollView>
      <EditSheet
        visible={adding}
        title="Add a name"
        fields={[{ key: 'v', label: 'As it’s written on the scoresheet', value: '', placeholder: 'BH' }]}
        onClose={() => setAdding(false)}
        onSave={(draft) => {
          setAdding(false);
          if (team) void update(learnName(team, draft.v));
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontFamily: fonts.bodySemiBold },
  input: { minHeight: 52, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 17, fontFamily: fonts.bodySemiBold },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 },
});
