import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { FormTemplate } from '@inkstat/forms';

import { allTemplates, readPhoto, recognizePhoto, samplePhoto, type ReadStatus } from '@/lib/reader';
import { Button, Card, ProgressBar, T } from '@/ui/components';
import { useDialog } from '@/ui/Dialog';
import { ReadingView, progressRect } from '@/ui/ReadingView';
import { base, fonts, space, useColors } from '@/ui/theme';

type Stage = 'start' | 'looking' | 'known' | 'unknown' | 'notext';

const KEEP_AWAKE_TAG = 'inkstat-reading';

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (since === null) return '';
  const s = Math.max(0, Math.round((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Scan: a photo of a form → which form it is (from its printed labels) → read.
 * With ?template=<id> the form is already chosen (testing a template); with
 * &sample=1 the template's bundled sample photo is read.
 */
export default function Scan() {
  const db = useSQLiteContext();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dialog = useDialog();
  const params = useLocalSearchParams<{ template?: string; sample?: string }>();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const [stage, setStage] = useState<Stage>('start');
  const [photo, setPhoto] = useState<string | null>(null);
  const [template, setTemplate] = useState<FormTemplate | null>(null);
  const [fixed, setFixed] = useState<FormTemplate | null>(null);
  const [status, setStatus] = useState<(ReadStatus & { startedAt: number }) | null>(null);
  const elapsed = useElapsed(status?.startedAt ?? null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  // Testing a template: it's already chosen; with a sample, the photo is too.
  useEffect(() => {
    if (!params.template) return;
    void (async () => {
      const t = (await allTemplates(db)).find((x) => x.id === params.template) ?? null;
      setFixed(t);
      setTemplate(t);
      if (t && params.sample) {
        setStage('looking');
        try {
          setPhoto(await samplePhoto(t.id));
          setStage('known');
        } catch (e) {
          setStage('start');
          void dialog.notice('No sample', e instanceof Error ? e.message : String(e));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, params.template, params.sample]);

  const pick = async (source: 'camera' | 'library') => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsEditing: Platform.OS === 'android' };
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return void dialog.notice('Camera access needed', 'Allow camera access in Settings, or choose a photo instead.');
    }
    const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return;
    const uri = result.assets[0].uri;
    setPhoto(uri);
    if (fixed) return setStage('known');
    setStage('looking');
    const { match, words } = await recognizePhoto(db, uri);
    setTemplate(match?.template ?? null);
    setStage(match ? 'known' : words < 8 ? 'notext' : 'unknown');
  };

  const chooseForm = async () => {
    const all = await allTemplates(db);
    dialog.actions(
      'Which form is it?',
      all.map((t) => ({
        label: t.name,
        hint: t.builtinId && !t.photoUri ? 'Built into InkStat' : 'Your template',
        onPress: () => {
          setTemplate(t);
          setStage('known');
        },
      })),
    );
  };

  const read = async () => {
    if (!template || !photo) return;
    abort.current = new AbortController();
    const startedAt = Date.now();
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    try {
      const saved = await readPhoto(db, template, photo, (s) => setStatus({ ...s, startedAt }), abort.current.signal);
      router.replace({ pathname: '/read/[id]', params: { id: saved.id } });
    } catch (e) {
      if (!abort.current?.signal.aborted) void dialog.notice('Reading failed', e instanceof Error ? e.message : String(e));
    } finally {
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      setStatus(null);
      abort.current = null;
    }
  };

  const title = fixed ? `Test: ${fixed.name}` : 'Scan a form';

  if (status) {
    return (
      <View style={[base.screen, base.content, { backgroundColor: c.bg, justifyContent: 'center' }]}>
        <Stack.Screen options={{ title }} />
        <ReadingView
          uri={status.uri}
          rect={status.doc && status.progress && status.progress.phase !== 'finished' ? progressRect(status.doc, status.progress) : null}
          width={screenW - space.lg * 2}
          height={Math.round(screenH * 0.42)}
        />
        <T style={base.h2}>{status.text}</T>
        <ProgressBar fraction={status.fraction} />
        <View style={[base.row, { justifyContent: 'space-between' }]}>
          <T muted style={base.small}>
            {status.progress ? `${status.progress.done + 1} of ${status.progress.total}` : ''}
          </T>
          <T muted style={[base.small, base.num]}>{elapsed}</T>
        </View>
        <T muted>Reading happens on this phone and takes a few minutes. Keep InkStat open.</T>
        <Button title="Cancel" kind="secondary" onPress={() => abort.current?.abort()} />
      </View>
    );
  }

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={[base.content, { paddingBottom: 190 }]}>
        {stage === 'start' && (
          <>
            <T style={styles.question}>{fixed ? `Take a photo of a filled-in ${fixed.name}` : 'Take a photo of the form'}</T>
            <T muted style={styles.lead}>
              {fixed ? 'InkStat lines the template up with your photo and reads it.' : 'InkStat works out which form it is from the printed labels, then reads it.'}
            </T>
            <View style={{ gap: space.sm }}>
              <T muted style={{ fontSize: 14 }}>{'✓  Flat, in good light, the whole page in the frame'}</T>
              <T muted style={{ fontSize: 14 }}>{'✓  Photos and data stay on this phone'}</T>
            </View>
          </>
        )}

        {stage === 'looking' && (
          <>
            {photo && <Image source={{ uri: photo }} style={[styles.photo, { backgroundColor: c.sunken }]} resizeMode="contain" />}
            <View style={{ alignItems: 'center', gap: space.sm, marginTop: space.md }}>
              <ActivityIndicator color={c.accent} size="large" />
              <T style={{ fontSize: 18, fontFamily: fonts.bodySemiBold }}>Finding the form…</T>
              <T muted style={{ fontSize: 14 }}>Reading the printed labels, on this phone</T>
            </View>
          </>
        )}

        {stage === 'known' && template && (
          <>
            <View style={[styles.banner, { backgroundColor: c.okBg, borderColor: c.ok }]}>
              <T style={[styles.overline, { color: c.ok }]}>{fixed ? (params.sample ? '✓ Sample photo' : '✓ Chosen') : '✓ Recognised'}</T>
              <T style={{ fontSize: 19, fontFamily: fonts.bodyBold }}>{template.name}</T>
              {params.sample ? <T muted style={{ fontSize: 13.5 }}>A made-up filled-in copy, photographed a little crooked.</T> : null}
            </View>
            {photo && <Image source={{ uri: photo }} style={[styles.photo, { backgroundColor: c.sunken }]} resizeMode="contain" />}
          </>
        )}

        {stage === 'unknown' && (
          <>
            {photo && <Image source={{ uri: photo }} style={[styles.photoSmall, { backgroundColor: c.sunken }]} resizeMode="contain" />}
            <T style={styles.question}>InkStat doesn’t know this form yet</T>
            <T muted style={styles.lead}>Pick it if it’s one InkStat knows, or build a template for it once and InkStat recognises it after that.</T>
            <Card>
              <T style={{ fontFamily: fonts.bodyBold, fontSize: 14 }}>Building a template</T>
              <T muted style={{ fontSize: 13.5 }}>Name each value you want and draw a box around it on this photo. Tables are a box with a column for each value.</T>
            </Card>
          </>
        )}

        {stage === 'notext' && (
          <>
            {photo && <Image source={{ uri: photo }} style={[styles.photoSmall, { backgroundColor: c.sunken }]} resizeMode="contain" />}
            <T style={styles.question}>InkStat couldn’t read this photo</T>
            <T muted style={styles.lead}>It found almost no printed words, so it can’t tell which form this is. That’s usually the photo, not the page.</T>
            <T style={{ fontSize: 15 }}>{'💡  More light, no shadow from your phone, and hold it flat above the page.'}</T>
          </>
        )}
      </ScrollView>

      {stage !== 'looking' && (
        <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: space.md + insets.bottom }]}>
          {stage === 'start' && (
            <>
              <Button title="Take a photo" size="lg" onPress={() => void pick('camera')} />
              <Button title="Choose from Photos" kind="secondary" onPress={() => void pick('library')} />
            </>
          )}
          {stage === 'known' && (
            <>
              <Button title="Read the form" size="lg" onPress={() => void read()} />
              {!fixed && <Button title="Not this form?" kind="secondary" onPress={() => void chooseForm()} />}
            </>
          )}
          {stage === 'unknown' && (
            <>
              <Button title="Build a template from this photo" size="lg" onPress={() => photo && router.push({ pathname: '/builder', params: { uri: photo } })} />
              <Button title="It’s a form InkStat knows: pick it" kind="secondary" onPress={() => void chooseForm()} />
            </>
          )}
          {stage === 'notext' && (
            <>
              <Button title="Take it again" size="lg" onPress={() => void pick('camera')} />
              <Button title="Pick the form anyway" kind="secondary" onPress={() => void chooseForm()} />
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  question: { fontSize: 22, fontFamily: fonts.headingBold, letterSpacing: -0.2 },
  lead: { fontSize: 15.5, lineHeight: 22 },
  overline: { fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.6, textTransform: 'uppercase' },
  banner: { borderWidth: 1.5, borderRadius: 8, padding: space.lg, gap: 4 },
  photo: { width: '100%', aspectRatio: 0.8, borderRadius: 8 },
  photoSmall: { width: '100%', height: 220, borderRadius: 8 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, gap: space.sm, borderTopWidth: 1 },
});
