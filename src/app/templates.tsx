import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { INDUSTRIES, LIBRARY, type FormTemplate, type KnownForm } from '@inkstat/forms';

import { listTemplates } from '@/db';
import { Badge, Card, T } from '@/ui/components';
import { base, fonts, space, useColors } from '@/ui/theme';

/**
 * Every form InkStat knows, by industry: built-in templates to test, and known
 * public forms without one yet, to build. Then the user's own templates.
 */
export default function Templates() {
  const db = useSQLiteContext();
  const c = useColors();
  const [mine, setMine] = useState<FormTemplate[]>([]);

  useFocusEffect(
    useCallback(() => {
      void listTemplates(db).then(setMine);
    }, [db]),
  );

  const open = (f: KnownForm) =>
    f.templateId
      ? router.push({ pathname: '/template/[id]', params: { id: f.templateId } })
      : router.push({ pathname: '/builder', params: { name: f.name, source: f.source ?? '' } });

  const fieldsOf = (t: FormTemplate) => t.fields.length + t.tables.reduce((n, x) => n + (x.orientation === 'rows' ? x.columns.length : x.fields.length), 0);

  return (
    <ScrollView style={[base.screen, { backgroundColor: c.bg }]} contentContainerStyle={[base.content, { paddingBottom: 48 }]}>
      <T muted style={{ fontSize: 14.5, lineHeight: 21 }}>
        A template tells InkStat where each value is on a form and how to check it. Test a built-in one on its sample photo or
        your own, or build one for any form.
      </T>

      <Card style={styles.list}>
        <View style={[styles.row, { borderTopWidth: 0 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <T style={styles.name}>Your templates</T>
            <T muted style={styles.sub}>{mine.length ? `${mine.length} built on this phone` : 'None yet'}</T>
          </View>
          <Pressable onPress={() => router.push('/builder')} accessibilityRole="button" hitSlop={8}>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>+ Build one</T>
          </Pressable>
        </View>
        {mine.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => router.push({ pathname: '/template/[id]', params: { id: t.id } })}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, { borderTopColor: c.border, backgroundColor: pressed ? c.sunken : 'transparent' }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <T style={styles.name}>{t.name}</T>
              <T muted style={styles.sub}>{`${fieldsOf(t)} values · ${t.checks.length} checks`}</T>
            </View>
            <T muted>›</T>
          </Pressable>
        ))}
      </Card>

      {INDUSTRIES.map((ind) => (
        <View key={ind.id} style={{ gap: space.sm }}>
          <View style={{ gap: 2, marginTop: space.sm }}>
            <T style={base.h2}>{ind.name}</T>
            <T muted style={styles.sub}>{ind.description}</T>
          </View>
          <Card style={styles.list}>
            {ind.forms.map((f, i) => {
              const t = f.templateId ? LIBRARY.find((x) => x.id === f.templateId) : undefined;
              return (
                <Pressable
                  key={f.name}
                  onPress={() => open(f)}
                  accessibilityRole="button"
                  accessibilityLabel={`${f.name}, ${t ? 'ready to test' : 'build a template'}`}
                  style={({ pressed }) => [styles.row, { borderTopColor: c.border, borderTopWidth: i ? 1 : 0, backgroundColor: pressed ? c.sunken : 'transparent' }]}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T style={styles.name}>{f.name}</T>
                    <T muted style={styles.sub}>{`${f.publisher} · ${f.summary}`}</T>
                  </View>
                  {t ? <Badge tone="ok" label="Ready" /> : <Badge tone="waiting" label="Build" />}
                </Pressable>
              );
            })}
          </Card>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { padding: 0, gap: 0, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, minHeight: 60 },
  name: { fontSize: 15.5, fontFamily: fonts.bodySemiBold },
  sub: { fontSize: 13, lineHeight: 18 },
});
