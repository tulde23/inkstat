import { builtinTemplate, type ExtractionProgress, type HomeAt, type NormRect, type SheetLayout, type TextLine } from '@inkstat/ocr-engine';
import { router, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { READ_IN_PROGRESS_KEY, clearSetting, listTemplates, saveGame, setSetting } from '@/db';
import {
  SCOREBOOK_PAGE_TEMPLATE,
  LIBRARY,
  SPORT_ID,
  applyTemplate,
  isUsable,
  recognizeSheet,
  templateForPhoto,
  emptyTeam,
  normalizeDate,
  today,
  readPage,
  seasonFor,
  type Game,
  type PageReading,
  type Recognition,
  type ScorebookTemplate,
  type Side,
} from '@inkstat/basketball';
import { extract, getActiveModelId } from '@/engine/host';
import { keepImage, newId } from '@/lib/files';
import { splitPage } from '@/lib/splitPage';
import { recognizePageText } from '../../modules/page-text';
import { Button, Card, ProgressBar, T } from '@/ui/components';
import { ReadingView, progressRect } from '@/ui/ReadingView';
import { useDialog } from '@/ui/Dialog';
import { base, fonts, space, useColors } from '@/ui/theme';

const REGION_LABELS: Record<string, string> = {
  ...Object.fromEntries(SCOREBOOK_PAGE_TEMPLATE.regions.map((r) => [r.id, r.label.toLowerCase()])),
  details: 'game details',
  timeouts: 'timeouts',
  team_fouls: 'team fouls',
  quarters: 'score by quarter',
};

/** uri / rect: the page being read and the part of it being read now, for the animation. */
type Status = { text: string; detail: string; fraction: number; startedAt: number; uri?: string; rect?: NormRect | null } | null;

const KEEP_AWAKE_TAG = 'inkstat-reading';

/** Within one crop: encoding the image is roughly the first 40%, writing the answer the rest. */
function cropFraction(p: ExtractionProgress): number {
  if (p.phase === 'finished') return 1;
  if (p.phase === 'looking') return 0.05;
  return 0.4 + 0.6 * Math.min(1, p.tokens / Math.max(1, p.maxTokens * 0.6));
}

function describeProgress(side: Side, p: ExtractionProgress): { text: string; detail: string } {
  const what = REGION_LABELS[p.regionId] ?? 'finishing';
  const part = p.tileCount > 1 ? ` (${p.tileIndex + 1} of ${p.tileCount})` : '';
  const detail =
    p.phase === 'looking' ? 'Looking at the page…' : p.phase === 'writing' ? `Writing results… ${p.tokens} tokens` : '';
  return { text: `Reading ${side} page: ${what}${part}`, detail };
}

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

export default function Scan() {
  const db = useSQLiteContext();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dialog = useDialog();
  // Recognise first: a photo, then InkStat works out which scoresheet it is.
  //   sure    → read straight away (asking for the other team's page if the book needs it)
  //   partly  → one tap: "Is this a <book>?"
  //   none    → show InkStat this page once (setup), then back here
  //   notext  → the photo is the problem: retake
  const [stage, setStage] = useState<Stage>('start');
  const [first, setFirst] = useState<string | null>(null);
  const [second, setSecond] = useState<string | null>(null);
  const [lines, setLines] = useState<TextLine[] | null>(null);
  const [rec, setRec] = useState<Recognition | null>(null);
  /** A scoresheet picked by hand (or confirmed), overriding recognition. */
  const [picked, setPicked] = useState<ScorebookTemplate | null>(null);
  const [swapped, setSwapped] = useState(false);
  /** Set while the scorekeeper is in setup for this photo; the new template is newer than this. */
  const [teaching, setTeaching] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const template: ScorebookTemplate | null = picked ?? (rec && (rec.kind === 'sure' || rec.kind === 'partly') ? rec.template : null);
  const arrangement = template ? arrange(template, rec, swapped, lines) : null;
  // One page is enough: the other team's page is optional (a scorekeeper may only keep their own book).
  const ready = !!template && !!first;
  const oneTeamOnly = arrangement?.kind === 'pages' && !second;

  const [status, setStatus] = useState<Status>(null);
  const { width: screenW, height: screenH } = useWindowDimensions();
  const elapsed = useElapsed(status?.startedAt ?? null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  /** Reads the printed words on the photo and matches them against every known scoresheet. */
  const recognise = useCallback(
    async (uri: string) => {
      const [text, all] = await Promise.all([recognizePageText(uri).catch(() => null), listTemplates(db)]);
      const found = text ?? [];
      const r = recognizeSheet(found, all.filter(isUsable));
      const what = r.kind === 'sure' || r.kind === 'partly' ? `${r.template.name} ${r.match.inliers}/${r.match.total}${r.spread ? ` spread ${r.spread}` : ''}` : `(${r.words} words)`;
      console.log(`[scan] recognised: ${r.kind} ${what}`);
      // Development builds log the printed text, to build and check built-in books from real photos.
      if (__DEV__) found.forEach((l) => console.log(`[scan-text] ${l.text} @ ${[l.rect.x, l.rect.y, l.rect.w, l.rect.h].map((n) => n.toFixed(3)).join(',')} | ${l.words.map((w) => `${w.text}:${w.rect.x.toFixed(3)},${w.rect.y.toFixed(3)},${w.rect.w.toFixed(3)},${w.rect.h.toFixed(3)}`).join(' ')}`));
      setLines(found);
      setRec(r);
      return r;
    },
    [db],
  );

  const stageFor = (r: Recognition): Stage => (r.kind === 'sure' ? 'known' : r.kind === 'partly' ? 'unsure' : r.kind === 'none' ? 'unknown' : 'notext');

  const startWith = async (uri: string) => {
    setFirst(uri);
    setSecond(null);
    setPicked(null);
    setSwapped(false);
    setSaved(null);
    setStage('looking');
    setStage(stageFor(await recognise(uri)));
  };

  // Back from setup: the page should now be recognised as the template just made.
  useFocusEffect(
    useCallback(() => {
      if (teaching === null || !first) return;
      const since = teaching;
      void recognise(first).then((r) => {
        setTeaching(null);
        if (r.kind === 'sure' && r.template.createdAt >= since) setSaved(r.template.name);
        setStage(r.kind === 'notext' ? 'unknown' : stageFor(r));
      });
    }, [teaching, first, recognise]),
  );

  const pick = async (source: 'camera' | 'library'): Promise<string | null> => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      quality: 1,
      // Android's editor allows free-form crops; iOS forces a square, which would cut the page.
      allowsEditing: Platform.OS === 'android',
    };
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        void dialog.notice('Camera access needed', 'Allow camera access in Settings, or choose a photo instead.');
        return null;
      }
    }
    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
    return result.canceled ? null : result.assets[0].uri;
  };

  const takeFirst = async (source: 'camera' | 'library') => {
    const uri = await pick(source);
    if (uri) await startWith(uri);
  };

  const replaceFirst = () =>
    dialog.actions('Use a different photo', [
      { label: 'Take a photo', hint: 'Flat, in good light, filling the frame', onPress: () => void takeFirst('camera') },
      { label: 'Choose from Photos', hint: 'A picture you already took', onPress: () => void takeFirst('library') },
    ]);

  const addSecond = () =>
    dialog.actions('Add the other team’s page', [
      { label: 'Take a photo', hint: 'Flat, in good light, filling the frame', onPress: () => void pick('camera').then((u) => u && setSecond(u)) },
      { label: 'Choose from Photos', hint: 'A picture you already took', onPress: () => void pick('library').then((u) => u && setSecond(u)) },
    ]);

  /** Every scoresheet InkStat knows, to pick by hand; or say it's new. */
  const chooseSheet = async () => {
    const mine = (await listTemplates(db)).filter(isUsable);
    const mineBuiltins = new Set(mine.map((t) => t.builtinId).filter(Boolean));
    const books = LIBRARY.filter((l) => !mineBuiltins.has(l.id)).map((l) => builtinTemplate(l, SPORT_ID));
    dialog.actions('Which scoresheet is it?', [
      ...mine.map((t) => ({ label: t.name, hint: 'Shown to InkStat', onPress: () => choose(t) })),
      ...books.map((t) => ({ label: t.name, hint: 'Built into InkStat', onPress: () => choose(t) })),
      { label: 'It’s a new scoresheet', hint: 'Show InkStat once, about two minutes', onPress: () => setStage('unknown') },
    ]);
  };
  const choose = (t: ScorebookTemplate) => {
    setPicked(t);
    setSwapped(false);
    setSaved(null);
    setStage('known');
  };

  /** Into setup, on the photo (or the home team's half of it), with the page layout just answered. */
  const teach = async (book: 'separate' | 'combined', homeAt?: HomeAt) => {
    if (!first) return;
    const uri = book === 'combined' && homeAt ? (await splitPage(first, homeAt)).home : first;
    const sheet: SheetLayout = book === 'combined' ? { teams: 'both', homeAt } : { teams: 'one' };
    setTeaching(Date.now());
    setStage('looking');
    router.push({ pathname: '/template-editor', params: { uri, sheet: JSON.stringify(sheet) } });
  };

  /** The photo to read for each team. */
  const teamPhotos = async (): Promise<Partial<Record<Side, string>>> => {
    if (!first || !arrangement) return {};
    if (arrangement.kind === 'split') return splitPage(first, arrangement.homeAt);
    const [home, away] = arrangement.firstIsHome ? [first, second] : [second, first];
    return { ...(home ? { home } : {}), ...(away ? { away } : {}) };
  };

  const read = async () => {
    const sheetTemplate = template;
    abort.current = new AbortController();
    const signal = abort.current.signal;
    const id = newId();
    // If Android kills InkStat for memory mid-read, nothing in JS runs; this marker lets
    // the next launch explain what happened instead of silently landing on Home.
    await setSetting(db, READ_IN_PROGRESS_KEY, String(Date.now()));
    // A read takes minutes. If the screen locks, Android demotes InkStat to a cached
    // process, the first thing it kills to free memory; keep the screen on until done.
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    try {
      const startedAt = Date.now();
      setStatus({ text: 'Getting the pages ready…', detail: '', fraction: 0, startedAt, uri: first ?? undefined, rect: null });
      const photos = await teamPhotos();
      const modelId = await getActiveModelId(db);
      const sides = (['home', 'away'] as const).filter((s) => photos[s]);
      const readings: Partial<Record<Side, PageReading>> = {};

      for (const [i, side] of sides.entries()) {
        const uri = keepImage(photos[side]!, id, side);
        // Line the recognised scoresheet's boxes up with this photo by its printed labels.
        const lines = await recognizePageText(uri);
        const chosen = templateForPhoto(sheetTemplate, lines);
        console.log(`[scan] ${side} template: ${chosen.source}${chosen.detail ? ` (${chosen.detail})` : ''}`);
        const template = chosen.template ? applyTemplate(SCOREBOOK_PAGE_TEMPLATE, chosen.template) : SCOREBOOK_PAGE_TEMPLATE;
        const run = await extract(modelId, uri, template, {
          signal,
          onModelLoad: (f) =>
            setStatus({ text: 'Loading the reading model…', detail: '', fraction: f, startedAt, uri, rect: null }),
          onProgress: (p) => {
            // One device-log line per crop: the only way to time a run on a phone.
            if (p.phase !== 'writing') {
              console.log(`[scan] ${side} ${p.phase} ${p.done + 1}/${p.total} ${p.regionId} +${Date.now() - startedAt}ms`);
            }
            setStatus({
              ...describeProgress(side, p),
              fraction: (i + (p.done + cropFraction(p)) / Math.max(1, p.total)) / sides.length,
              startedAt,
              uri,
              rect: p.phase === 'finished' ? null : progressRect(template, p),
            });
          },
        });
        console.log(`[scan] ${side} read in ${run.finishedAt - run.startedAt}ms with ${run.modelId}`);
        // The model's exact answer per crop: when a field comes back blank, this shows
        // whether the model left it out or wrote it in a shape the schema didn't accept.
        for (const r of run.results) {
          console.log(`[scan] raw ${side} ${r.regionId}#${r.tileIndex}: ${r.raw.replace(/\s+/g, ' ').slice(0, 1500)}`);
          if (r.warnings.length) console.log(`[scan] warnings ${side} ${r.regionId}#${r.tileIndex}: ${r.warnings.join('; ')}`);
        }
        const reading = readPage(run);
        reading.team.crops = reading.team.crops.map((cr, k) => ({
          ...cr,
          uri: keepImage(cr.uri, id, `${side}-crop-${k}`),
        }));
        readings[side] = reading;
      }

      const home = readings.home?.team ?? emptyTeam();
      const away = readings.away?.team ?? emptyTeam();
      // Each page names its opponent; use that when the other page didn't name its own team.
      home.name ??= readings.away?.opponent ?? null;
      away.name ??= readings.home?.opponent ?? null;
      // No date read off the sheet: it was almost always played today. The date stays editable on the game.
      const date = normalizeDate(readings.home?.date ?? readings.away?.date ?? null) ?? today();
      const now = Date.now();
      const game: Game = {
        id,
        date,
        location: readings.home?.location ?? readings.away?.location ?? null,
        season: seasonFor(date),
        home,
        away,
        modelId,
        createdAt: now,
        updatedAt: now,
      };
      await saveGame(db, game);

      const failures = sides.flatMap((s) => readings[s]!.failures.map((f) => `${s}: ${f}`));
      const notes = sides.flatMap((s) => readings[s]!.notes.map((n) => `${s}: ${n}`));
      if (failures.length) {
        void dialog.notice(
          'Some parts could not be read',
          `${failures.join('\n')}\n\nYou can fill these in by hand on the next screen.`,
        );
      } else if (notes.length) {
        void dialog.notice('Adjusted while reading', notes.join('\n'));
      }
      router.replace({ pathname: '/game/[id]', params: { id } });
    } catch (e) {
      if (!signal.aborted) void dialog.notice('Reading failed', e instanceof Error ? e.message : String(e));
    } finally {
      await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      await clearSetting(db, READ_IN_PROGRESS_KEY);
      setStatus(null);
      abort.current = null;
    }
  };

  if (status) {
    return (
      <View style={[base.screen, base.content, { backgroundColor: c.bg, justifyContent: 'center' }]}>
        {status.uri && <ReadingView uri={status.uri} rect={status.rect ?? null} width={screenW - space.lg * 2} height={Math.round(screenH * 0.42)} />}
        <T style={base.h2}>{status.text}</T>
        <ProgressBar fraction={status.fraction} />
        <View style={[base.row, { justifyContent: 'space-between' }]}>
          <T muted style={base.small}>{status.detail}</T>
          <T muted style={[base.small, base.num]}>{elapsed}</T>
        </View>
        <T muted>This takes a minute or two per page on most phones. Keep InkStat open.</T>
        <Button title="Cancel" kind="secondary" onPress={() => abort.current?.abort()} />
      </View>
    );
  }

  const isBuiltin = !!template && template.id.startsWith('builtin-');
  const homeAway = arrangement?.kind === 'pages' ? (arrangement.firstIsHome ? [first, second] : [second, first]) : [];

  return (
    <View style={[base.screen, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={[base.content, { paddingBottom: 190 }]}>
        {stage === 'start' && (
          <>
            <T style={styles.question}>Take a photo of the scoresheet</T>
            <T muted style={styles.lead}>InkStat works out which scoresheet it is. If each team has its own sheet, it asks for the other one next.</T>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take a photo"
              onPress={() => void takeFirst('camera')}
              style={({ pressed }) => [styles.bigSlot, { borderColor: c.accent, backgroundColor: pressed ? c.sunken : 'transparent' }]}>
              <CameraIcon color={c.accent} />
              <T style={{ color: c.accent, fontFamily: fonts.bodyBold, fontSize: 18 }}>Take a photo</T>
              <T muted style={{ fontSize: 13 }}>Flat, good light, the whole page in</T>
            </Pressable>
            <View style={{ gap: space.sm }}>
              <T muted style={{ fontSize: 14 }}>{'✓  A book open to both teams? One photo of both pages is fine.'}</T>
              <T muted style={{ fontSize: 14 }}>{'✓  Photos stay on this phone.'}</T>
            </View>
          </>
        )}

        {stage === 'looking' && (
          <>
            {first && <Image source={{ uri: first }} style={[styles.photo, { backgroundColor: c.sunken }]} resizeMode="contain" />}
            <View style={{ alignItems: 'center', gap: space.sm, marginTop: space.md }}>
              <ActivityIndicator color={c.accent} size="large" />
              <T style={{ fontSize: 18, fontFamily: fonts.bodySemiBold }}>Finding your scoresheet…</T>
              <T muted style={{ fontSize: 14 }}>Reading the printed labels, on this phone</T>
            </View>
          </>
        )}

        {stage === 'known' && template && arrangement && (
          <>
            <View style={[styles.banner, { backgroundColor: c.okBg, borderColor: c.ok }]}>
              <T style={[styles.overline, { color: c.ok }]}>{saved ? '✓ Saved' : picked ? '✓ Chosen' : '✓ Recognised'}</T>
              <T style={{ fontSize: 19, fontFamily: fonts.bodyBold }}>{template.name}</T>
              <T muted style={{ fontSize: 13.5 }}>
                {saved ? 'Next time InkStat recognises it and reads it straight away.' : isBuiltin ? 'Built into InkStat' : 'A scoresheet InkStat was shown'}
              </T>
            </View>

            {arrangement.kind === 'split' ? (
              <>
                <PhotoSlot label="Both teams" wide uri={first} onPress={replaceFirst} replaceLabel="Use a different photo" />
                <View style={[base.row, { gap: space.sm }]}>
                  <T muted style={{ flex: 1, fontSize: 14 }}>{`One photo, both teams: home on the ${arrangement.homeAt}.`}</T>
                  <LinkButton label="⇄ Swap" onPress={() => setSwapped((v) => !v)} />
                </View>
              </>
            ) : (
              <>
                {!second && <T style={styles.question}>Add the other team’s page?</T>}
                {!second && <T muted style={styles.lead}>Optional. Add it to read both teams, or read just this one.</T>}
                <View style={[base.row, { alignItems: 'flex-start', gap: space.md }]}>
                  {homeAway.map((uri, k) => (
                    <PhotoSlot
                      key={k}
                      label={k === 0 ? 'Home team' : 'Away team'}
                      uri={uri}
                      onPress={uri !== null && uri === first ? replaceFirst : addSecond}
                    />
                  ))}
                </View>
                <View style={[base.row, { gap: space.sm }]}>
                  <T muted style={{ flex: 1, fontSize: 14 }}>
                    {arrangement.guessed ? 'The first page’s heading says it’s the visiting team’s.' : 'The first page went on the home side.'}
                  </T>
                  <LinkButton label="⇄ Swap" onPress={() => setSwapped((v) => !v)} />
                </View>
              </>
            )}
          </>
        )}

        {stage === 'unsure' && rec?.kind === 'partly' && (
          <>
            <T style={styles.question}>{`Is this a ${rec.template.name}?`}</T>
            <T muted style={styles.lead}>Some of the printed labels match, but not all. It could be an older printing or a similar book.</T>
            <View style={[base.row, { gap: space.md, alignItems: 'flex-start' }]}>
              <View style={{ flex: 1, gap: space.xs }}>
                <T style={{ fontFamily: fonts.bodyBold, fontSize: 13 }}>Your photo</T>
                {first && <Image source={{ uri: first }} style={[styles.half, { backgroundColor: c.sunken }]} resizeMode="contain" />}
              </View>
              <View style={{ flex: 1, gap: space.xs }}>
                <T style={{ fontFamily: fonts.bodyBold, fontSize: 13 }}>{rec.template.name}</T>
                {rec.template.photoUri ? (
                  <Image source={{ uri: rec.template.photoUri }} style={[styles.half, { backgroundColor: c.sunken }]} resizeMode="contain" />
                ) : (
                  <View style={[styles.half, { backgroundColor: c.sunken, padding: space.md, justifyContent: 'center' }]}>
                    <T muted style={{ fontSize: 13 }}>{LIBRARY.find((l) => l.id === rec.template.builtinId)?.description ?? ''}</T>
                  </View>
                )}
              </View>
            </View>
            <T muted style={{ fontSize: 13.5 }}>Look at the headings and the boxes at the top. If they’re laid out the same way, it’s the same book.</T>
          </>
        )}

        {stage === 'unknown' && (
          <>
            {first && <Image source={{ uri: first }} style={[styles.photoSmall, { backgroundColor: c.sunken }]} resizeMode="contain" />}
            <T style={styles.question}>InkStat hasn’t seen this scoresheet yet</T>
            <T muted style={styles.lead}>Show it where things are on the page, once. It takes about two minutes, and then InkStat knows this scoresheet every time.</T>
            <Card>
              <T style={{ fontFamily: fonts.bodyBold, fontSize: 14 }}>You won’t start from nothing</T>
              <T muted style={{ fontSize: 13.5 }}>InkStat places the boxes it can find from the printed headings. You check them and fix any that are off.</T>
            </Card>
            <Card>
              <T style={{ fontFamily: fonts.bodyBold, fontSize: 14 }}>Your league can use it too</T>
              <T muted style={{ fontSize: 13.5 }}>Only the printed layout is ever shared, never names, scores or photos.</T>
            </Card>
          </>
        )}

        {stage === 'layout' && (
          <>
            <T style={styles.question}>How is this scoresheet laid out?</T>
            <T muted style={styles.lead}>InkStat remembers this with the scoresheet, so you only answer once.</T>
            <Choice
              title={BOOK_LABEL.separate}
              body="One team per sheet or page. You’ll add the other team’s page when scanning."
              picture={<Diagram kind="separate" />}
              onPress={() => void teach('separate')}
            />
            <Choice title={BOOK_LABEL.combined} body="Or a book open to both teams’ pages, in one photo." picture={<Diagram kind="combined" />} onPress={() => setStage('where')} />
          </>
        )}

        {stage === 'where' && (
          <>
            <T style={styles.question}>Where is the home team on the page?</T>
            <T muted style={styles.lead}>InkStat cuts the photo in two and reads each team’s half.</T>
            <View style={styles.grid}>
              {(['top', 'bottom', 'left', 'right'] as const).map((h) => (
                <Choice key={h} compact title={`${h[0].toUpperCase()}${h.slice(1)}`} picture={<Diagram kind={h} />} onPress={() => void teach('combined', h)} />
              ))}
            </View>
            <T muted style={base.small}>Home is usually marked HOME or H next to the team name.</T>
          </>
        )}

        {stage === 'notext' && (
          <>
            {first && <Image source={{ uri: first }} style={[styles.photoSmall, { backgroundColor: c.sunken }]} resizeMode="contain" />}
            <T style={styles.question}>InkStat couldn’t read this photo</T>
            <T muted style={styles.lead}>It found almost no printed words, so it can’t tell which scoresheet this is. That’s usually the photo, not the page.</T>
            <View style={{ gap: space.sm }}>
              <T style={{ fontSize: 15 }}>{'💡  More light, and no shadow from your phone'}</T>
              <T style={{ fontSize: 15 }}>{'📐  Hold the phone flat above the page'}</T>
              <T style={{ fontSize: 15 }}>{'🔍  Tap the screen to focus before taking it'}</T>
            </View>
          </>
        )}
      </ScrollView>

      {stage !== 'looking' && (
        <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.border, paddingBottom: space.md + insets.bottom }]}>
          {stage === 'start' && <Button title="Choose from Photos" kind="secondary" size="lg" onPress={() => void takeFirst('library')} />}
          {stage === 'known' && (
            <>
              <Button title={oneTeamOnly ? 'Read this team’s page' : 'Read the scoresheet'} size="lg" disabled={!ready} onPress={read} />
              {!saved && <LinkButton center label="Not this scoresheet?" onPress={() => void chooseSheet()} />}
            </>
          )}
          {stage === 'unsure' && rec?.kind === 'partly' && (
            <>
              <Button title="Yes, it’s this one" size="lg" onPress={() => choose(rec.template)} />
              <Button title="No, it’s different" kind="secondary" onPress={() => setStage('unknown')} />
              <T muted style={[base.small, { textAlign: 'center' }]}>Not sure? Choose Yes. You can check every number after the read.</T>
            </>
          )}
          {stage === 'unknown' && (
            <>
              <Button title="Show InkStat this page" size="lg" onPress={() => setStage('layout')} />
              <LinkButton center label="It’s a scoresheet InkStat knows: pick it" onPress={() => void chooseSheet()} />
            </>
          )}
          {(stage === 'layout' || stage === 'where') && (
            <LinkButton center label="Back" onPress={() => setStage(stage === 'where' ? 'layout' : 'unknown')} />
          )}
          {stage === 'notext' && (
            <>
              <Button title="Take it again" size="lg" onPress={() => void takeFirst('camera')} />
              <LinkButton center label="Choose a different photo" onPress={() => void takeFirst('library')} />
            </>
          )}
        </View>
      )}
    </View>
  );
}

type Stage = 'start' | 'looking' | 'known' | 'unsure' | 'unknown' | 'layout' | 'where' | 'notext';

const BOOK_LABEL = {
  separate: 'Each team has its own page',
  combined: 'Both teams on one page',
} as const;

type Arrangement = { kind: 'split'; homeAt: HomeAt } | { kind: 'pages'; firstIsHome: boolean; guessed: boolean };

const FLIP: Record<HomeAt, HomeAt> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * How this game's photos map to teams. A page with both teams is cut in two at the
 * template's home side; a book spread (one team per page, both pages in the photo)
 * is cut left and right, home on the left as books print it; otherwise each team
 * has its own photo, and the first page's heading may say it's the visitors'.
 */
function arrange(t: ScorebookTemplate, rec: Recognition | null, swapped: boolean, lines: TextLine[] | null): Arrangement {
  const spread = rec && (rec.kind === 'sure' || rec.kind === 'partly') && rec.template.id === t.id ? rec.spread : null;
  if (t.sheet?.teams === 'both') {
    const at = t.sheet.homeAt ?? 'top';
    return { kind: 'split', homeAt: swapped ? FLIP[at] : at };
  }
  if (spread) return { kind: 'split', homeAt: swapped ? 'right' : 'left' };
  const away = headingSaysAway(lines);
  return { kind: 'pages', firstIsHome: away === swapped, guessed: away };
}

/** The top of the page names it the visiting team's (and not home's). */
function headingSaysAway(lines: TextLine[] | null): boolean {
  if (!lines) return false;
  const top = lines.filter((l) => l.rect.y < 0.3).map((l) => l.text.toLowerCase());
  const has = (re: RegExp) => top.some((t) => re.test(t));
  return has(/\b(visitors?|visiting|guests?|opponents?|away)\b/) && !has(/\bhome\b/);
}

function LinkButton({ label, onPress, center }: { label: string; onPress: () => void; center?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8} style={{ minHeight: 44, justifyContent: 'center', alignSelf: center ? 'center' : undefined }}>
      <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold, fontSize: 15 }}>{label}</T>
    </Pressable>
  );
}

function CameraIcon({ color }: { color: string }) {
  return (
    <Svg width={44} height={44} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <Circle cx={12} cy={13} r={3.5} />
    </Svg>
  );
}

function Choice({
  title,
  body,
  tag,
  picture,
  compact,
  onPress,
}: {
  title: string;
  body?: string;
  tag?: string;
  picture: React.ReactNode;
  compact?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, body, tag].filter(Boolean).join('. ')}
      onPress={onPress}
      style={({ pressed }) => [
        compact ? styles.choiceCompact : styles.choice,
        { borderColor: tag ? c.accent : c.border, borderWidth: tag ? 2 : 1.5, backgroundColor: pressed ? c.sunken : c.card },
      ]}>
      {picture}
      <View style={compact ? { alignItems: 'center', gap: 2 } : { flex: 1, gap: 3 }}>
        <T style={{ fontFamily: fonts.bodyBold, fontSize: 16 }}>{title}</T>
        {body && <T muted style={{ fontSize: 14 }}>{body}</T>}
        {tag && <T style={[base.small, { color: c.accent, fontFamily: fonts.bodySemiBold }]}>{tag}</T>}
      </View>
      {!compact && <T style={{ fontSize: 22, color: tag ? c.accent : c.muted }}>›</T>}
    </Pressable>
  );
}

/** A small drawing of the page(s): ruled lines, with the home team's part highlighted. */
function Diagram({ kind }: { kind: 'separate' | 'combined' | HomeAt }) {
  const c = useColors();
  const narrow = kind === 'left' || kind === 'right';
  const part = (home: boolean) => (
    <View style={{ flex: 1, padding: 3, justifyContent: 'center', backgroundColor: home ? c.warnBg : c.card }}>
      <T style={{ fontSize: 8, fontFamily: fonts.bodyBold, color: home ? c.warn : c.muted, textAlign: 'center' }}>{narrow ? (home ? 'H' : 'A') : home ? 'HOME' : 'AWAY'}</T>
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      <View style={[styles.rule, { backgroundColor: c.border }]} />
    </View>
  );
  const page = (children: React.ReactNode, across = false, size = styles.page) => (
    <View style={[size, { borderColor: c.muted, flexDirection: across ? 'row' : 'column' }]}>{children}</View>
  );
  if (kind === 'separate') {
    return (
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {page(part(true), false, styles.pageSmall)}
        {page(part(false), false, styles.pageSmall)}
      </View>
    );
  }
  const across = kind === 'left' || kind === 'right';
  const homeFirst = kind === 'combined' || kind === 'top' || kind === 'left';
  const divider = <View style={across ? { width: 1, backgroundColor: c.muted } : { height: 1, backgroundColor: c.muted }} />;
  return (
    <View style={kind === 'combined' ? { width: 92, alignItems: 'center' } : undefined}>
      {page(
        <>
          {part(homeFirst)}
          {divider}
          {part(!homeFirst)}
        </>,
        across,
      )}
    </View>
  );
}

/** An empty dashed slot to add a photo, or the photo with Replace. */
function PhotoSlot({ label, uri, wide, onPress, replaceLabel = 'Replace' }: { label: string; uri: string | null; wide?: boolean; onPress: () => void; replaceLabel?: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, gap: space.xs }}>
      <View style={[base.row, { gap: 6 }]}>
        <T style={{ fontFamily: fonts.bodyBold }}>{label}</T>
        {uri && <T style={{ color: c.ok, fontFamily: fonts.bodyBold }}>✓</T>}
      </View>
      {uri ? (
        <>
          <Image source={{ uri }} style={[styles.slot, wide && styles.slotWide, { backgroundColor: c.sunken }]} resizeMode="contain" />
          <Button title={replaceLabel} kind="secondary" onPress={onPress} />
        </>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add the ${label.toLowerCase()} photo`}
          onPress={onPress}
          style={({ pressed }) => [
            styles.slot,
            wide && styles.slotWide,
            styles.empty,
            { borderColor: c.accent, backgroundColor: pressed ? c.sunken : 'transparent' },
          ]}>
          <T style={{ fontSize: 34, lineHeight: 38, color: c.accent }}>+</T>
          <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Add photo</T>
          <T muted style={{ fontSize: 12 }}>Camera or Photos</T>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { flexDirection: 'row', gap: 4, flex: 1, marginRight: space.md },
  progressBar: { flex: 1, height: 4, borderRadius: 2 },
  stepLabel: { fontFamily: fonts.monoBold, fontSize: 12 },
  question: { fontFamily: fonts.headingBold, fontSize: 24, lineHeight: 30, marginTop: space.xs },
  lead: { fontSize: 15 },
  tip: { borderRadius: 8, padding: space.md },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 10, padding: 14, minHeight: 104 },
  choiceCompact: { width: '47%', flexGrow: 1, alignItems: 'center', gap: space.sm, borderRadius: 10, paddingVertical: 14, paddingHorizontal: space.sm, minHeight: 140 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  page: { width: 52, height: 68, borderWidth: 1.5, borderRadius: 3, overflow: 'hidden' },
  pageSmall: { width: 44, height: 58, borderWidth: 1.5, borderRadius: 3, overflow: 'hidden' },
  rule: { height: 2, borderRadius: 1, marginTop: 4 },
  overline: { fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.5, textTransform: 'uppercase' },
  slot: { width: '100%', height: 210, borderRadius: 8 },
  slotWide: { height: 260 },
  empty: { borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 2 },
  bigSlot: { height: 280, borderRadius: 12, borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  photo: { width: '100%', height: 380, borderRadius: 8 },
  photoSmall: { width: '100%', height: 220, borderRadius: 8 },
  half: { width: '100%', height: 230, borderRadius: 8 },
  banner: { borderWidth: 1, borderRadius: 8, padding: space.md, gap: 4 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, gap: space.xs, borderTopWidth: 1 },
});
