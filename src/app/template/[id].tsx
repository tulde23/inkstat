import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { INDUSTRIES, type FieldDef, type FormTemplate } from '@inkstat/forms';

import { deleteTemplate } from '@/db';
import { alignedTo, allTemplates, hasSample, samplePhoto } from '@/lib/reader';
import { Button, Card, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { PageMarker } from '@/ui/PageMarker';
import { shapesOf } from '@/ui/templateShapes';
import { base, fonts, space, useColors } from '@/ui/theme';

const KIND: Record<FieldDef['kind'], string> = {
  text: 'text',
  number: 'number',
  integer: 'whole number',
  date: 'date',
  time: 'time',
  checkbox: 'tick box',
  choice: 'choice',
  timeTemp: 'time / temp',
};

const describeDef = (d: FieldDef) =>
  [KIND[d.kind], d.unit, d.min !== undefined || d.max !== undefined ? `${d.min ?? '…'}–${d.max ?? '…'}` : null].filter(Boolean).join(' · ');

/** What a template reads and checks, and testing it. */
export default function TemplateScreen() {
  const db = useSQLiteContext();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dialog = useDialog();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width: screenW } = useWindowDimensions();
  const [t, setT] = useState<FormTemplate | null>(null);
  /** The page its boxes are drawn on: the user's photo, or a built-in's sample. */
  const [page, setPage] = useState<{ uri: string; aspect: number; boxes: FormTemplate } | null>(null);

  useFocusEffect(
    useCallback(() => {
      void allTemplates(db).then((all) => setT(all.find((x) => x.id === id) ?? null));
    }, [db, id]),
  );

  const sampleId = t ? (t.builtinId ?? t.id) : '';
  useEffect(() => {
    if (!t) return;
    let live = true;
    // The user's own template was drawn on its own photo; a built-in is lined up with its sample.
    const load = async () => {
      const uri = t.photoUri ?? (hasSample(sampleId) ? await samplePhoto(sampleId) : null);
      if (!uri) return;
      const boxes = t.photoUri ? t : await alignedTo(t, uri);
      Image.getSize(uri, (w, h) => live && setPage({ uri, aspect: w / h, boxes }), () => undefined);
    };
    void load().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [t, sampleId]);

  if (!t) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  const builtin = !!t.builtinId && t.builtinId === t.id;
  const known = INDUSTRIES.flatMap((i) => i.forms.map((f) => ({ ...f, industry: i.name }))).find((f) => f.templateId === (t.builtinId ?? t.id));

  const remove = async () => {
    const ok = await dialog.confirm({ title: 'Delete this template?', subject: { label: t.name }, body: 'Forms already read with it are kept.', confirm: 'Delete', destructive: true });
    if (!ok) return;
    await deleteTemplate(db, t.id);
    router.back();
  };

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: t.name }} />
      <ScrollView contentContainerStyle={[base.content, { paddingBottom: 220 }]}>
        <Card>
          {known && <T muted style={styles.overline}>{`${known.industry} · ${known.publisher}`}</T>}
          <T style={{ fontSize: 15, lineHeight: 21 }}>{t.description ?? 'Your template.'}</T>
          {t.source && (
            <Pressable onPress={() => void Linking.openURL(t.source!)} accessibilityRole="link" hitSlop={8}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>The blank form ›</T>
            </Pressable>
          )}
        </Card>

        {page && (
          <Card style={styles.list}>
            <View style={styles.head}>
              <T style={base.h2}>Where it reads</T>
              <T muted style={base.small}>
                {builtin ? 'On the sample photo. To change a box, make a copy.' : 'On your photo. Edit to change a box.'}
              </T>
            </View>
            {/* Display only: the screen scrolls over it. */}
            <View pointerEvents="none">
              <PageMarker uri={page.uri} aspect={page.aspect} width={screenW - space.lg * 2} height={Math.round((screenW - space.lg * 2) / page.aspect)} shapes={shapesOf(page.boxes)} allowDraw={false} />
            </View>
          </Card>
        )}

        {t.fields.length > 0 && (
          <Card style={styles.list}>
            <T style={[base.h2, styles.head]}>{`Single values (${t.fields.length})`}</T>
            {t.fields.map((f) => (
              <View key={f.id} style={[styles.line, { borderTopColor: c.border }]}>
                <T style={styles.label}>{f.label}</T>
                <T muted style={styles.kind}>{describeDef(f)}</T>
              </View>
            ))}
          </Card>
        )}

        {t.tables.map((table) => (
          <Card key={table.id} style={styles.list}>
            <View style={styles.head}>
              <T style={base.h2}>{table.label}</T>
              <T muted style={base.small}>
                {table.orientation === 'rows' ? `Up to ${table.maxRows} rows, a column for each value` : `${table.records} records side by side, a printed row for each value`}
              </T>
            </View>
            {(table.orientation === 'rows' ? table.columns : table.fields).map((d) => (
              <View key={d.id} style={[styles.line, { borderTopColor: c.border }]}>
                <T style={styles.label}>{d.label}</T>
                <T muted style={styles.kind}>{describeDef(d)}</T>
              </View>
            ))}
          </Card>
        ))}

        {t.checks.length > 0 && (
          <Card style={styles.list}>
            <T style={[base.h2, styles.head]}>{`Checks (${t.checks.length})`}</T>
            {t.checks.map((ch) => (
              <View key={ch.id} style={[styles.line, { borderTopColor: c.border, flexDirection: 'column', gap: 2 }]}>
                <T style={{ fontSize: 14.5 }}>{ch.label}</T>
                <T muted style={{ fontSize: 12.5, fontFamily: fonts.mono }}>{ch.rule}</T>
              </View>
            ))}
            <T muted style={[base.small, styles.head]}>Every number is also checked against its range.</T>
          </Card>
        )}
      </ScrollView>

      <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: space.md + insets.bottom }]}>
        {hasSample(t.builtinId ?? t.id) && (
          <Button title="Test on the sample photo" size="lg" onPress={() => router.push({ pathname: '/scan', params: { template: t.id, sample: '1' } })} />
        )}
        <Button title="Test on my own photo" kind="secondary" onPress={() => router.push({ pathname: '/scan', params: { template: t.id } })} />
        {builtin && (
          <Pressable onPress={() => router.push({ pathname: '/builder', params: { copy: t.id } })} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'center' }}>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Make a copy to edit</T>
          </Pressable>
        )}
        {!builtin && (
          <View style={[base.row, { justifyContent: 'space-between' }]}>
            <Pressable onPress={() => router.push({ pathname: '/builder', params: { id: t.id } })} accessibilityRole="button" hitSlop={8}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Edit</T>
            </Pressable>
            <Pressable onPress={() => void remove()} accessibilityRole="button" hitSlop={8}>
              <T style={{ color: c.error, fontFamily: fonts.bodySemiBold }}>Delete</T>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overline: { fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.5, textTransform: 'uppercase' },
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  head: { paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
  line: { flexDirection: 'row', gap: space.md, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1 },
  label: { flex: 1, fontSize: 14.5 },
  kind: { fontSize: 13, textAlign: 'right' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, gap: space.sm, borderTopWidth: 1 },
});
