import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { READ_IN_PROGRESS_KEY, clearSetting, deleteRead, getSetting, listReads, type SavedRead } from '@/db';
import { activeModel, type ActiveModel } from '@/engine/host';
import { deleteImages } from '@/lib/files';
import { Badge, Button, Card, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { Logo } from '@/ui/Logo';
import { base, fonts, space, useColors } from '@/ui/theme';
import { useLightStatusBar } from '@/ui/useLightStatusBar';

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Home: scan a form, and every form read on this phone. */
export default function Home() {
  const db = useSQLiteContext();
  const c = useColors();
  const dialog = useDialog();
  useLightStatusBar();
  const [reads, setReads] = useState<SavedRead[]>([]);
  const [model, setModel] = useState<ActiveModel | null>(null);
  const [killedMidRead, setKilledMidRead] = useState(false);

  const load = useCallback(async () => {
    const [all, current, interrupted] = await Promise.all([listReads(db), activeModel(db), getSetting(db, READ_IN_PROGRESS_KEY)]);
    setReads(all);
    setModel(current);
    setKilledMidRead(interrupted !== null);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const remove = async (r: SavedRead) => {
    const ok = await dialog.confirm({
      title: 'Delete this read?',
      subject: { label: r.template.name, value: when(r.createdAt) },
      body: 'Its data and photo are deleted from this phone.',
      confirm: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await deleteRead(db, r.id);
    deleteImages(r.id);
    void load();
  };

  const more = () =>
    dialog.actions('More', [
      { label: 'Form templates', hint: 'Built-in forms and your own', onPress: () => router.push('/templates') },
      { label: 'Reading model', hint: model?.name, onPress: () => router.push('/models') },
      { label: 'Account', hint: 'Sign in', onPress: () => router.push('/account') },
    ]);

  const needsModel = !!model && !model.ready;

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.header }}>
        <View style={styles.header}>
          <View style={[styles.logoChip, { backgroundColor: c.bg }]}>
            <Logo size={22} />
          </View>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={[base.content, { paddingHorizontal: space.md, paddingBottom: 120 }]}>
        {killedMidRead && (
          <Card style={{ backgroundColor: c.errorBg, borderColor: c.error }}>
            <T style={[base.h2, { color: c.error }]}>Reading was interrupted</T>
            <T>
              Android closed InkStat while it was reading a form, almost always because the phone ran low on memory. Close
              other apps and try again.
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
            <T>InkStat reads forms entirely on this phone. It needs a one-time download of {model.name} first. Use Wi-Fi.</T>
            <Button title="Set up model" onPress={() => router.push('/models')} />
          </Card>
        )}

        {reads.length === 0 ? (
          <Card>
            <T style={base.h2}>Photograph a paper form, get its data</T>
            <T muted style={{ lineHeight: 21 }}>
              InkStat recognises the form, reads every box and table on this phone, checks the numbers against the form’s own
              rules, and exports JSON, CSV or YAML.
            </T>
            <Pressable onPress={() => router.push('/templates')} accessibilityRole="button" hitSlop={8}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>See the forms it knows ›</T>
            </Pressable>
          </Card>
        ) : (
          <Card style={styles.list}>
            <View style={styles.listHead}>
              <T style={[base.h2, { flex: 1 }]}>Forms read</T>
              <T muted style={{ fontSize: 13 }}>{String(reads.length)}</T>
            </View>
            {reads.map((r) => (
              <ReadRow key={r.id} read={r} onDelete={() => void remove(r)} />
            ))}
          </Card>
        )}
        {reads.length > 0 && <T muted style={base.small}>Press and hold a form to delete it.</T>}
      </ScrollView>

      {/* Bottom bar: the scan button sits in the middle, raised. */}
      <SafeAreaView edges={['bottom']} style={[styles.bottom, { backgroundColor: c.card, borderTopColor: c.border }]}>
        <View style={styles.bottomRow}>
          <Pressable style={styles.bottomItem} onPress={() => router.push('/templates')} accessibilityRole="button">
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M5 3h10l4 4v14H5zM15 3v4h4M8 11h8M8 15h8M8 19h5" />
            </Svg>
            <Text style={[styles.bottomLabel, { color: c.accent }]}>Templates</Text>
          </Pressable>
          <Pressable style={styles.bottomItem} onPress={() => router.push(needsModel ? '/models' : '/scan')} accessibilityRole="button" accessibilityLabel="Scan a form">
            <View style={[styles.fab, { backgroundColor: c.accent }]}>
              <Svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke={c.accentText} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
                <Path d="M7 12h10" />
              </Svg>
            </View>
            <Text style={[styles.bottomLabel, { color: c.text }]}>Scan a form</Text>
          </Pressable>
          <Pressable style={styles.bottomItem} onPress={more} accessibilityRole="button">
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.muted} strokeWidth={2} strokeLinecap="round">
              <Path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3.5} />
            </Svg>
            <Text style={[styles.bottomLabel, { color: c.muted }]}>More</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

function ReadRow({ read, onDelete }: { read: SavedRead; onDelete: () => void }) {
  const c = useColors();
  const failed = read.checks.filter((x) => x.status === 'fail').length;
  const issues = read.data.issues.length;
  const rows = Object.values(read.data.tables).reduce((n, t) => n + t.length, 0);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/read/[id]', params: { id: read.id } })}
      onLongPress={onDelete}
      accessibilityRole="button"
      accessibilityLabel={`${read.template.name}, ${when(read.createdAt)}`}
      style={({ pressed }) => [styles.row, { borderTopColor: c.border, backgroundColor: pressed ? c.sunken : 'transparent' }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontFamily: fonts.bodySemiBold, color: c.text }}>
          {read.template.name}
        </Text>
        <T muted style={{ fontSize: 13 }}>{`${when(read.createdAt)}${rows ? ` · ${rows} row${rows === 1 ? '' : 's'}` : ''}`}</T>
      </View>
      {failed > 0 ? (
        <Badge tone="error" label={`${failed} check${failed === 1 ? '' : 's'} failed`} />
      ) : issues > 0 ? (
        <Badge tone="warn" label={`${issues} to look at`} />
      ) : (
        <Badge tone="ok" label="Checks pass" />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.sm, flexDirection: 'row' },
  logoChip: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  listHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, minHeight: 60 },
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
