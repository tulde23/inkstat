import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { defsOf, toCSV, toJSON, toYAML, type CheckResult, type FieldDef, type Value } from '@inkstat/forms';

import { getRead, type SavedRead } from '@/db';
import { shareText } from '@/lib/files';
import { Badge, Button, Card, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { base, fonts, space, useColors } from '@/ui/theme';

/** A value as shown: blank as a dash, ticks as ✓, time/temperature pairs as "03:20 · 68". */
function show(v: Value, f?: FieldDef): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'boolean') return v ? '✓ ticked' : 'not ticked';
  if (typeof v === 'object') return [v.time, v.temp !== null ? `${v.temp}${f?.unit ?? ''}` : null].filter(Boolean).join(' · ') || '–';
  return f?.unit && typeof v === 'number' ? `${v} ${f.unit}` : String(v);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One form read: what it says, what the checks found, and export. */
export default function ReadScreen() {
  const db = useSQLiteContext();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dialog = useDialog();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [read, setRead] = useState<SavedRead | null>(null);
  const [showPhoto, setShowPhoto] = useState(false);

  useEffect(() => {
    void getRead(db, id).then(setRead);
  }, [db, id]);

  if (!read) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  const t = read.template;
  const base_ = `${slug(t.name)}-${new Date(read.createdAt).toISOString().slice(0, 10)}`;
  const failed = read.checks.filter((x) => x.status === 'fail');
  const passed = read.checks.filter((x) => x.status === 'pass').length;
  const skipped = read.checks.filter((x) => x.status === 'skipped').length;

  const share = (name: string, text: string, mime: string) =>
    shareText(name, text, mime).catch((e) => dialog.notice('Couldn’t share', e instanceof Error ? e.message : String(e)));

  const exportAs = () => {
    const csv = toCSV(t, read.data);
    dialog.actions('Export', [
      { label: 'JSON', hint: 'Everything in one file', onPress: () => void share(`${base_}.json`, toJSON(read.data, read.checks), 'application/json') },
      { label: 'YAML', hint: 'The same, easier to read', onPress: () => void share(`${base_}.yaml`, toYAML(read.data, read.checks), 'application/yaml') },
      ...Object.entries(csv).map(([file, text]) => ({
        label: `CSV: ${file}`,
        hint: file === 'fields.csv' ? 'The single values' : 'A row per record, for spreadsheets',
        onPress: () => void share(`${base_}-${file}`, text, 'text/csv'),
      })),
    ]);
  };

  const defs: Record<string, FieldDef> = Object.fromEntries([...t.fields, ...t.tables.flatMap(defsOf)].map((d) => [d.id, d]));
  const failuresAt = (table: string, row: number) => failed.filter((f) => f.table === table && f.row === row);

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: t.name }} />
      <ScrollView contentContainerStyle={[base.content, { paddingBottom: 120 }]}>
        <Card>
          <View style={[base.row, { justifyContent: 'space-between' }]}>
            <T muted style={base.small}>{`${new Date(read.createdAt).toLocaleString()} · ${read.seconds}s`}</T>
            {failed.length ? <Badge tone="error" label={`${failed.length} failed`} /> : <Badge tone="ok" label="Checks pass" />}
          </View>
          <T>{`${passed} check${passed === 1 ? '' : 's'} passed${failed.length ? `, ${failed.length} failed` : ''}${skipped ? `, ${skipped} skipped (values not read)` : ''}.`}</T>
          <Pressable onPress={() => setShowPhoto((v) => !v)} accessibilityRole="button" hitSlop={8}>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>{showPhoto ? 'Hide the photo' : 'Show the photo'}</T>
          </Pressable>
          {showPhoto && <Image source={{ uri: read.photoUri }} style={[styles.photo, { backgroundColor: c.sunken }]} resizeMode="contain" />}
        </Card>

        {(failed.length > 0 || read.data.issues.length > 0) && (
          <Card style={{ backgroundColor: c.warnBg, borderColor: c.warnLine }}>
            <T style={base.h2}>Look at these</T>
            {failed.map((f, i) => (
              <CheckLine key={i} check={f} />
            ))}
            {read.data.issues.map((s, i) => (
              <T key={`i${i}`} style={{ fontSize: 14 }}>{`• ${s}`}</T>
            ))}
            <T muted style={base.small}>A failed check is a misread or a mistake on the paper. Compare with the photo.</T>
          </Card>
        )}

        {t.fields.length > 0 && (
          <Card style={styles.list}>
            <T style={[base.h2, styles.head]}>Fields</T>
            {t.fields.map((f) => (
              <View key={f.id} style={[styles.line, { borderTopColor: c.border }]}>
                <T muted style={styles.label}>{f.label}</T>
                <T style={styles.value}>{show(read.data.fields[f.id] ?? null, f)}</T>
              </View>
            ))}
          </Card>
        )}

        {t.tables.map((table) => {
          const rows = read.data.tables[table.id] ?? [];
          const cols = defsOf(table);
          const titleOf = (row: Record<string, Value>, i: number) =>
            table.orientation === 'rows' && table.key ? show(row[table.key] ?? null) : `${table.label} ${i + 1}`;
          return (
            <View key={table.id} style={{ gap: space.sm }}>
              <T style={base.h2}>{`${table.label} (${rows.length})`}</T>
              {rows.length === 0 && <T muted>Nothing read in this table.</T>}
              {rows.map((row, i) => {
                const bad = failuresAt(table.id, i + 1);
                return (
                  <Card key={i} style={[styles.list, bad.length ? { borderColor: c.error } : {}]}>
                    <View style={[base.row, styles.head]}>
                      <T style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 16 }}>{titleOf(row, i)}</T>
                      {bad.length > 0 && <Badge tone="error" label={`${bad.length} failed`} />}
                    </View>
                    {cols
                      .filter((d) => !(table.orientation === 'rows' && d.id === table.key))
                      .map((d) => (
                        <View key={d.id} style={[styles.line, { borderTopColor: c.border }]}>
                          <T muted style={styles.label}>{d.label}</T>
                          <T style={styles.value}>{show(row[d.id] ?? null, defs[d.id])}</T>
                        </View>
                      ))}
                    {bad.map((f, k) => (
                      <View key={`f${k}`} style={[styles.line, { borderTopColor: c.border, backgroundColor: c.errorBg }]}>
                        <CheckLine check={f} />
                      </View>
                    ))}
                  </Card>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
      <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: space.md + insets.bottom }]}>
        <Button title="Export: JSON, CSV or YAML" size="lg" onPress={exportAs} />
      </View>
    </View>
  );
}

function CheckLine({ check }: { check: CheckResult }) {
  const c = useColors();
  return (
    <View style={{ gap: 2, flex: 1 }}>
      <T style={{ fontFamily: fonts.bodySemiBold, fontSize: 14, color: c.error }}>{`✕ ${check.label}${check.row && check.table ? ` (row ${check.row})` : ''}`}</T>
      <T muted style={{ fontSize: 13 }}>{check.detail}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  head: { paddingHorizontal: 14, paddingVertical: 10 },
  line: { flexDirection: 'row', gap: space.md, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, alignItems: 'flex-start' },
  label: { flex: 1, fontSize: 14 },
  value: { flex: 1, fontSize: 15, fontFamily: fonts.mono, textAlign: 'right' },
  photo: { width: '100%', aspectRatio: 0.8, borderRadius: 6 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, borderTopWidth: 1 },
});
