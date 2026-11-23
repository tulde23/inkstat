import { DEFAULT_PARTS, partSpec, type PartId, type ScorebookTemplate } from '@inkstat/basketball';
import type { NormRect } from '@inkstat/ocr-engine';
import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, T } from './components';
import { PART_COLORS } from './partColors';
import { PhotoViewer } from './PhotoViewer';
import { base, fonts, space, useColors } from './theme';

/**
 * The guided parts of building a template, for scorekeepers who are not technical:
 * an intro that says what is about to happen, then plain yes/no questions about the
 * page instead of a list of switches, and a small drawing of where each part
 * usually sits.
 */

/** Where a part usually is on a page, as a rect (bands take the player-rows height). */
function usualRect(part: PartId): NormRect {
  const r = DEFAULT_PARTS[part];
  if ('y' in r) return r;
  const rows = DEFAULT_PARTS.rows as NormRect;
  return { x: r.x, w: r.w, y: rows.y, h: rows.h };
}

/**
 * A small drawing of a typical scoresheet with the given parts highlighted:
 * "look about here". Ruled lines stand in for the writing.
 */
export function PageHint({ parts, width = 96 }: { parts: PartId[]; width?: number }) {
  const c = useColors();
  const height = Math.round(width * 1.3);
  const rows = DEFAULT_PARTS.rows as NormRect;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.page, { width, height, borderColor: c.muted, backgroundColor: c.card }]}>
      {/* Ruled lines: a header strip, then the player rows. */}
      {[0.05, 0.1, 0.22, 0.26].map((y) => (
        <View key={y} style={[styles.line, { top: y * height, left: width * 0.08, right: width * 0.08, backgroundColor: c.border }]} />
      ))}
      {Array.from({ length: 9 }, (_, i) => rows.y + (rows.h * (i + 0.5)) / 9).map((y) => (
        <View key={y} style={[styles.line, { top: y * height, left: width * 0.06, right: width * 0.06, backgroundColor: c.border }]} />
      ))}
      {parts.map((p) => {
        const r = usualRect(p);
        return (
          <View
            key={p}
            style={{
              position: 'absolute',
              left: r.x * width,
              top: r.y * height,
              width: Math.max(4, r.w * width),
              height: Math.max(4, r.h * height),
              borderWidth: 2,
              borderRadius: 2,
              borderColor: PART_COLORS[p],
              backgroundColor: PART_COLORS[p] + '40',
            }}
          />
        );
      })}
    </View>
  );
}

// ── Intro ───────────────────────────────────────────────────────────────────

export function IntroPhase({ hasPhoto, onStart }: { hasPhoto: boolean; onStart: () => void }) {
  const c = useColors();
  const steps = [
    { title: 'Take a photo', body: 'One page from a finished game, flat and in good light.' },
    { title: 'Answer a few questions', body: 'Yes or no: what your scoresheet has on it.' },
    { title: 'Show InkStat where things are', body: 'One thing at a time. InkStat places each box; you move it if it’s off.' },
    { title: 'Test it', body: 'InkStat reads your photo, so you see straight away that it works.' },
  ];
  return (
    <>
      <ScrollView contentContainerStyle={[base.content, { gap: space.lg }]}>
        <View style={{ gap: space.sm }}>
          <T style={base.h1}>Teach InkStat your scoresheet</T>
          <T muted style={{ fontSize: 16, lineHeight: 23 }}>
            Every scorebook puts things in different places. A template shows InkStat where to look on yours. You do it
            once per kind of book, and every scan after that reads much better.
          </T>
        </View>
        <View style={{ gap: space.md }}>
          {steps.map((s, i) => (
            <View key={s.title} style={[base.row, { alignItems: 'flex-start', gap: space.md }]}>
              <View style={[styles.num, { backgroundColor: c.accent }]}>
                <T style={{ color: c.accentText, fontFamily: fonts.bodyBold }}>{String(i + 1)}</T>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontFamily: fonts.bodyBold, fontSize: 16 }}>{s.title}</T>
                <T muted style={{ fontSize: 14.5, lineHeight: 20 }}>{s.body}</T>
              </View>
            </View>
          ))}
        </View>
        <View style={[styles.note, { backgroundColor: c.sunken }]}>
          <T muted style={{ fontSize: 14, lineHeight: 20 }}>
            About two minutes. Everything saves as you go, so you can stop and come back.
          </T>
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Button title={hasPhoto ? 'Start with this photo' : 'Start'} size="lg" onPress={onStart} />
      </View>
    </>
  );
}

// ── Questions ───────────────────────────────────────────────────────────────

const QUESTIONS: { q: string; hint: string; parts: PartId[] }[] = [
  {
    q: 'Does each player have fouls marked on their row?',
    hint: 'Usually boxes numbered 1 to 5, or an F or PF column.',
    parts: ['fouls'],
  },
  {
    q: 'Is the team’s name written on the page?',
    hint: 'Usually at the top, next to TEAM, HOME or VISITOR.',
    parts: ['teamName'],
  },
  {
    q: 'Are the date, place or coach written at the top?',
    hint: 'Say yes if any of them are. You can skip the missing ones later.',
    parts: ['date', 'location', 'coach'],
  },
  {
    q: 'Is there a box for the score in each quarter?',
    hint: 'Often labelled 1 2 3 4 OT, or SCORE BY PERIODS.',
    parts: ['quarters'],
  },
  {
    q: 'Does it track timeouts or team fouls?',
    hint: 'Small grids of boxes, usually near the top.',
    parts: ['timeouts', 'teamFouls'],
  },
];

export function AskPhase({
  tpl,
  photo,
  question,
  recognised,
  placing,
  onQuestion,
  onAnswer,
  onUseRecognised,
  onBack,
  onStartMarking,
  onPlaceAll,
  onAdvanced,
}: {
  tpl: ScorebookTemplate;
  /** The scorekeeper's photo, shown with each question so they can check their own page. */
  photo: string | null;
  /** -1: the recognised-book screen; 0..n-1: a question; n: the summary. */
  question: number;
  /** The name of a built-in book this photo matched, if any. */
  recognised: string | null;
  placing: boolean;
  onQuestion: (i: number) => void;
  onAnswer: (parts: PartId[], yes: boolean) => void;
  onUseRecognised: () => void;
  onBack: () => void;
  onStartMarking: () => void;
  onPlaceAll: () => void;
  onAdvanced: () => void;
}) {
  const c = useColors();
  const [zoom, setZoom] = useState(false);

  // Still reading the printed labels: wait, so a recognised book can be offered first.
  if (placing && question <= 0) {
    return (
      <View style={[base.content, { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.md }]}>
        <T style={base.h2}>Looking at your page…</T>
        <T muted style={{ textAlign: 'center' }}>InkStat is reading the printed labels to see if it knows this scoresheet.</T>
      </View>
    );
  }

  if (question < 0 && recognised) {
    return (
      <>
        <ScrollView contentContainerStyle={[base.content, { gap: space.md }]}>
          <View style={[styles.found, { backgroundColor: c.okBg, borderColor: c.ok }]}>
            <T style={{ color: c.ok, fontFamily: fonts.bodyBold, fontSize: 13, letterSpacing: 0.5 }}>GOOD NEWS</T>
            <T style={base.h1}>{`This looks like the ${recognised}`}</T>
            <T style={{ fontSize: 15, lineHeight: 21 }}>
              InkStat already knows where everything is on this book. It will line its boxes up with your photo, then
              you check them.
            </T>
          </View>
        </ScrollView>
        <View style={styles.footer}>
          <Button title="Use it, then check the boxes" size="lg" onPress={onUseRecognised} />
          <Pressable onPress={() => onQuestion(0)} accessibilityRole="button" style={styles.link}>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>It’s a different book: set it up myself</T>
          </Pressable>
        </View>
      </>
    );
  }

  if (question < QUESTIONS.length) {
    const qi = Math.max(0, question);
    const item = QUESTIONS[qi];
    const yes = item.parts.some((p) => tpl.enabled.includes(p));
    const answer = (v: boolean) => {
      onAnswer(item.parts, v);
      onQuestion(qi + 1);
    };
    return (
      <>
        <ScrollView contentContainerStyle={[base.content, { gap: space.md }]}>
          <T muted style={styles.counter}>{`QUESTION ${qi + 1} OF ${QUESTIONS.length}`}</T>
          <T style={base.h1}>{item.q}</T>
          <View style={[base.row, { alignItems: 'flex-start', gap: space.md }]}>
            <PageHint parts={item.parts} width={72} />
            <View style={{ flex: 1, gap: space.sm }}>
              <T style={{ fontSize: 15, lineHeight: 21 }}>{item.hint}</T>
              <T muted style={base.small}>The coloured box shows where most scoresheets put it.</T>
            </View>
          </View>
          {photo && (
            <Pressable onPress={() => setZoom(true)} accessibilityRole="imagebutton" accessibilityLabel="Your page. Tap to zoom in." style={{ gap: 4 }}>
              <Image source={{ uri: photo }} style={[styles.photo, { backgroundColor: c.sunken }]} resizeMode="contain" />
              <T muted style={[base.small, { textAlign: 'center' }]}>Your page · tap to zoom in</T>
            </Pressable>
          )}
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            {[true, false].map((v) => (
              <Pressable
                key={String(v)}
                onPress={() => answer(v)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.answer,
                  { borderColor: yes === v ? c.accent : c.border, backgroundColor: pressed ? c.sunken : c.card },
                ]}>
                <T style={{ fontFamily: fonts.bodyBold, fontSize: 17 }}>{v ? 'Yes, it has this' : 'No, it doesn’t'}</T>
              </Pressable>
            ))}
          </View>
        </ScrollView>
        {photo && <PhotoViewer photos={[{ uri: photo, label: 'Your page' }]} index={zoom ? 0 : null} onClose={() => setZoom(false)} />}
        <View style={styles.footer}>
          <Button title="Back" kind="secondary" onPress={() => (qi === 0 ? (recognised ? onQuestion(-1) : onBack()) : onQuestion(qi - 1))} />
        </View>
      </>
    );
  }

  // Summary: what comes next, in order.
  const list = [...new Set(tpl.enabled)].filter((p) => partSpec(p).status !== 'planned');
  return (
    <>
      <ScrollView contentContainerStyle={[base.content, { gap: space.md }]}>
        <T style={base.h1}>{`Now show InkStat ${list.length} things`}</T>
        <T muted style={{ fontSize: 15, lineHeight: 21 }}>
          One at a time. InkStat puts a box where it thinks each one is. If the box is right, tap “Looks right”. If not,
          drag it into place.
        </T>
        <View style={[styles.list, { backgroundColor: c.card, borderColor: c.border }]}>
          {list.map((p, i) => (
            <View key={p} style={[styles.listRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}>
              <T muted style={{ width: 22, fontFamily: fonts.monoBold }}>{String(i + 1)}</T>
              <View style={[styles.swatch, { backgroundColor: PART_COLORS[p] }]} />
              <T style={{ flex: 1, fontFamily: fonts.bodySemiBold }}>{partSpec(p).name}</T>
            </View>
          ))}
        </View>
        <Pressable onPress={onAdvanced} accessibilityRole="button" style={styles.link}>
          <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>See every part (advanced)</T>
        </Pressable>
      </ScrollView>
      <View style={styles.footer}>
        <Button title="Start" size="lg" onPress={onStartMarking} />
        <View style={[base.row, { marginTop: 4 }]}>
          <View style={{ flex: 1 }}>
            <Button title="Back" kind="secondary" onPress={() => onQuestion(QUESTIONS.length - 1)} />
          </View>
          <View style={{ flex: 2 }}>
            <Button title="Place them all, I’ll check" kind="secondary" onPress={onPlaceAll} />
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  page: { borderWidth: 1.5, borderRadius: 4, overflow: 'hidden' },
  photo: { width: '100%', height: 230, borderRadius: 8 },
  line: { position: 'absolute', height: 1.5, borderRadius: 1 },
  num: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  note: { borderRadius: 10, padding: space.md },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md, gap: 4 },
  found: { borderWidth: 1.5, borderRadius: 12, padding: space.lg, gap: space.sm },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  counter: { fontFamily: fonts.monoBold, fontSize: 12, letterSpacing: 0.5 },
  answer: { minHeight: 60, borderWidth: 2, borderRadius: 12, justifyContent: 'center', paddingHorizontal: space.lg },
  list: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.md, minHeight: 48 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
});
