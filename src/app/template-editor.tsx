import {
  DEFAULT_PARTS,
  DETAIL_PARTS,
  PARTS,
  PART_GROUPS,
  REQUIRED_PARTS,
  SCOREBOOK_PAGE_TEMPLATE,
  applyTemplate,
  isUsable,
  markedParts,
  newTemplate,
  normalizeTemplate,
  partSpec,
  alignParts,
  anchorsForTemplate,
  matchLibrary,
  placeParts,
  suggestParts,
  variantOf,
  readPage,
  templateChecks,
  type PartCheck,
  type PartStatus,
  type PartId,
  type LibraryMatch,
  type Placement,
  type ScorebookTemplate,
} from '@inkstat/basketball';
import type { NormRect, TextLine } from '@inkstat/ocr-engine';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getTemplate, listTemplates, saveTemplate, setActiveTemplate } from '@/db';
import { extract, getActiveModelId } from '@/engine/host';
import { keepImage, readBenchMarks, writeBenchMarks } from '@/lib/files';
import { recognizePageText } from '../../modules/page-text';
import { Button, Card, ProgressBar, T } from '@/ui/components';
import { PageMarker, PhotoCrop, type MarkerShape } from '@/ui/PageMarker';
import { PART_COLORS } from '@/ui/partColors';
import { ReadingView, progressRect } from '@/ui/ReadingView';
import { AskPhase, IntroPhase, PageHint } from '@/ui/TemplateGuide';
import { useDialog } from '@/ui/Dialog';
import { base, fonts, space, useColors, type Colors } from '@/ui/theme';

type Phase = 'intro' | 'photo' | 'pick' | 'mark' | 'review' | 'test';

/**
 * Side margin around the marking photo. Android's back gesture claims swipes that
 * start near the screen edges; keeping the photo (and every handle on it) clear of
 * them means a drag near the edge moves the box instead of leaving the screen.
 */
const EDGE = 28;
const PHASES: { key: Phase[]; label: string }[] = [
  { key: ['photo'], label: 'Photo' },
  { key: ['pick'], label: 'Questions' },
  { key: ['mark'], label: 'Mark' },
  { key: ['review', 'test'], label: 'Check' },
];

/** A marking step: one part, or the game details together. */
interface Step {
  key: string;
  parts: PartId[];
}

function stepsFor(t: ScorebookTemplate): Step[] {
  const on = (id: PartId) => t.enabled.includes(id);
  const steps: Step[] = [];
  for (const p of PARTS) {
    if (!on(p.id)) continue;
    if (DETAIL_PARTS.includes(p.id)) {
      const last = steps[steps.length - 1];
      if (last?.key === 'details') last.parts.push(p.id);
      else steps.push({ key: 'details', parts: [p.id] });
    } else steps.push({ key: p.id, parts: [p.id] });
  }
  return steps;
}

const isBand = (id: PartId) => partSpec(id).shape === 'band';

/** A part's full rect on the page; bands take their height from the rows box. */
function fullRect(t: ScorebookTemplate, id: PartId): NormRect | null {
  const v = t.parts[id];
  if (!v) return null;
  if (!isBand(id)) return v as NormRect;
  const rows = (t.parts.rows ?? DEFAULT_PARTS.rows) as NormRect;
  return { x: v.x, w: v.w, y: rows.y, h: rows.h };
}

const STATUS_LABEL: Record<PartStatus, string> = { strong: 'Strong', ok: 'OK', weak: 'Weak', untested: 'New', planned: 'Coming soon' };

function StatusChip({ status, c }: { status: PartStatus; c: Colors }) {
  const [bg, fg] =
    status === 'strong' ? [c.okBg, c.ok] : status === 'ok' ? [c.accent + '22', c.accent] : status === 'weak' ? [c.warnBg, c.warn] : [c.sunken, c.muted];
  return <T style={[styles.status, { backgroundColor: bg, color: fg }]}>{STATUS_LABEL[status]}</T>;
}

export default function TemplateEditor() {
  // benchId (development): mark a test-bench sample's boxes; saving writes them to that sample.
  // sheet: how the page is laid out (JSON SheetLayout), when started from a scan that asked.
  const { id, uri, benchId, sheet } = useLocalSearchParams<{ id?: string; uri?: string; benchId?: string; sheet?: string }>();
  const db = useSQLiteContext();
  const c = useColors();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const [tpl, setTpl] = useState<ScorebookTemplate | null>(null);
  // New templates open on a short intro; existing ones open on review (set when loaded).
  const [phase, setPhase] = useState<Phase>('intro');
  // Questions about the page (-1: the recognised-book offer), or the full parts list.
  const [question, setQuestion] = useState(-1);
  const [advanced, setAdvanced] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [detail, setDetail] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  // Where the printed labels suggest each part is; computed once per photo.
  const [placement, setPlacement] = useState<{
    uri: string;
    result: Placement | null;
    /** A built-in scorebook this photo was recognised as, with its boxes lined up to the photo. */
    library: (LibraryMatch & { parts: ReturnType<typeof alignParts> }) | null;
    anchors: ScorebookTemplate['anchors'];
    lines: TextLine[] | null;
  } | null>(null);
  const [autoPlaced, setAutoPlaced] = useState<{ parts: PartId[]; recognised: string | null } | null>(null);

  // Load: an existing template opens on review; a new one starts on the photo.
  useEffect(() => {
    (async () => {
      if (benchId && uri) {
        const saved = readBenchMarks(benchId);
        const t = newTemplate(`bench-${benchId}`, `Bench: ${benchId}`, uri);
        setTpl(saved ? { ...t, ...saved } : t);
        setPhase(saved ? 'review' : 'pick');
        return;
      }
      if (id) {
        const t = await getTemplate(db, id);
        if (t) {
          setTpl(t);
          setPhase(t.photoUri ? 'review' : 'photo');
          return;
        }
      }
      const count = (await listTemplates(db)).length;
      const tid = `tpl-${Date.now().toString(36)}`;
      const fresh = newTemplate(tid, count ? `Scorebook ${count + 1}` : 'My scorebook', uri ? keepImage(uri, tid, 'photo') : null);
      setTpl(sheet ? { ...fresh, sheet: parseSheet(sheet) } : fresh);
    })();
  }, [db, id, uri, benchId, sheet]);

  // Save as you go: a reload, crash or accidental back never loses marked boxes.
  // (An unfinished template shows in the list as needing rows, names and points.)
  useEffect(() => {
    if (!tpl || benchId || !tpl.photoUri) return;
    const timer = setTimeout(() => {
      void saveTemplate(db, normalizeTemplate(tpl));
    }, 600);
    return () => clearTimeout(timer);
  }, [db, tpl, benchId]);

  const photo = tpl?.photoUri ?? null;
  useEffect(() => {
    if (photo) Image.getSize(photo, (w, h) => setAspect(w / h), () => setAspect(1.3));
  }, [photo]);

  // Read the page's printed labels in the background as soon as there is a photo.
  useEffect(() => {
    if (!photo) return;
    let live = true;
    recognizePageText(photo).then((lines) => {
      if (!live) return;
      const result = lines ? placeParts(lines) : null;
      const lib = lines ? matchLibrary(lines) : null;
      const library = lib ? { ...lib, parts: alignParts(lib.layout.parts, lib.match) } : null;
      if (lib) console.log(`[library] matched ${lib.layout.id}: ${lib.match.inliers}/${lib.match.total} labels`);
      // Development builds log the recognized text, to capture new test fixtures for placement.
      if (__DEV__) lines?.forEach((l) => console.log(`[autoplace-text] ${l.text} @ ${[l.rect.x, l.rect.y, l.rect.w, l.rect.h].map((n) => n.toFixed(3)).join(',')} | ${l.words.map((w) => `${w.text}:${w.rect.x.toFixed(3)},${w.rect.y.toFixed(3)},${w.rect.w.toFixed(3)},${w.rect.h.toFixed(3)}`).join(' ')}`));
      console.log(`[autoplace] ${lines?.length ?? 'no'} text lines; placed ${result?.found.join(', ') || 'nothing'}`);
      setPlacement({ uri: photo, result, library, anchors: lines ? anchorsForTemplate(lines) : undefined, lines });
    });
    return () => {
      live = false;
    };
  }, [photo]);
  const current = placement?.uri === photo ? placement : null;
  const suggested = current?.result ?? null;
  // A recognised built-in book knows where everything is; label guessing is the fallback.
  const startRect = (p: PartId) => current?.library?.parts[p] ?? suggested?.parts[p] ?? DEFAULT_PARTS[p];

  if (!tpl) return <View style={[base.screen, { backgroundColor: c.bg }]} />;

  const steps = stepsFor(tpl);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const update = (fn: (t: ScorebookTemplate) => ScorebookTemplate) =>
    setTpl((t) => (t ? { ...fn(t), updatedAt: Date.now() } : t));

  // Entering a step: give each of its parts a starting box to adjust, if it has none.
  const enterStep = (i: number, chip = 0) => {
    const s = stepsFor(tpl)[i];
    if (!s) return;
    update((t) => {
      const parts = { ...t.parts };
      for (const p of s.parts) if (!parts[p]) parts[p] = startRect(p);
      return { ...t, parts };
    });
    setStepIndex(i);
    setDetail(chip);
    setPhase('mark');
  };

  /** Puts every part's box where the photo suggests, then goes to review. */
  const autoPlace = () => {
    const lib = current?.library;
    if (lib) {
      // A known book: use its parts, lined up to this photo.
      update((t) => ({
        ...t,
        enabled: lib.layout.enabled,
        parts: { ...lib.parts },
        variants: { ...lib.layout.variants },
        builtinId: lib.layout.id,
      }));
      setAutoPlaced({ parts: lib.layout.enabled, recognised: lib.layout.name });
    } else {
      update((t) => {
        const parts = { ...t.parts };
        for (const p of t.enabled) parts[p] = startRect(p);
        return { ...t, parts };
      });
      setAutoPlaced({ parts: tpl.enabled.filter((p) => suggested?.found.includes(p)), recognised: null });
    }
    setPhase('review');
  };

  const save = async (t: ScorebookTemplate) => {
    // Keep this photo's printed labels, so later photos can be lined up with the boxes.
    const clean = normalizeTemplate({ ...t, anchors: t.anchors ?? current?.anchors });
    if (benchId) {
      writeBenchMarks(benchId, clean);
      return clean;
    }
    await saveTemplate(db, clean);
    // The first usable template becomes the one scans use.
    const all = await listTemplates(db);
    if (isUsable(clean) && all.length === 1) await setActiveTemplate(db, clean.id);
    return clean;
  };

  return (
    <SafeAreaView style={[base.screen, { backgroundColor: c.bg }]} edges={['bottom']}>
      {/* Edge swipes are for moving boxes here, not going back (iOS; Android's system gesture is avoided by the photo's side margins). */}
      <Stack.Screen options={{ title: tpl.name || 'Template', gestureEnabled: false }} />
      {phase !== 'intro' && <Stepper phase={phase} c={c} fraction={phase === 'mark' ? (stepIndex + 1) / steps.length : 0} />}

      {phase === 'intro' && <IntroPhase hasPhoto={!!photo} onStart={() => setPhase('photo')} />}

      {phase === 'photo' && (
        <PhotoPhase
          tpl={tpl}
          c={c}
          aspect={aspect}
          width={screenW - space.lg * 2}
          onName={(name) => update((t) => ({ ...t, name }))}
          onPhoto={(u) => update((t) => ({ ...t, photoUri: keepImage(u, t.id, 'photo') }))}
          onNext={() => {
            setQuestion(-1);
            setAdvanced(false);
            setPhase('pick');
          }}
        />
      )}

      {phase === 'pick' && !advanced && (
        <AskPhase
          tpl={tpl}
          photo={photo}
          question={question}
          recognised={current?.library?.layout.name ?? null}
          placing={!!photo && placement?.uri !== photo}
          onQuestion={setQuestion}
          onAnswer={(parts, yes) =>
            update((t) => ({
              ...t,
              enabled: yes ? [...new Set([...t.enabled, ...parts])] : t.enabled.filter((x) => !parts.includes(x)),
            }))
          }
          onUseRecognised={autoPlace}
          onBack={() => setPhase('photo')}
          onStartMarking={() => {
            setAutoPlaced(null);
            enterStep(0);
          }}
          onPlaceAll={autoPlace}
          onAdvanced={() => setAdvanced(true)}
        />
      )}

      {phase === 'pick' && advanced && (
        <PickPhase
          tpl={tpl}
          c={c}
          onToggle={(p, on) =>
            update((t) => ({ ...t, enabled: on ? [...t.enabled, p] : t.enabled.filter((x) => x !== p) }))
          }
          onBack={() => setAdvanced(false)}
          onNext={() => {
            setAutoPlaced(null);
            enterStep(0);
          }}
          placing={!!photo && placement?.uri !== photo}
          onAuto={autoPlace}
        />
      )}

      {phase === 'mark' && photo && aspect && step && (
        <MarkPhase
          key={step.key}
          tpl={tpl}
          step={step}
          stepNumber={stepIndex + 1}
          stepCount={steps.length}
          found={(p) => !!current?.library?.parts[p] || !!suggested?.found.includes(p)}
          detail={Math.min(detail, step.parts.length - 1)}
          onDetail={setDetail}
          c={c}
          uri={photo}
          aspect={aspect}
          width={screenW - EDGE * 2}
          height={Math.round(screenH * 0.36)}
          onRect={(p, r) => update((t) => ({ ...t, parts: { ...t.parts, [p]: isBand(p) ? { x: r.x, w: r.w } : r } }))}
          onVariant={(p, v) => update((t) => ({ ...t, variants: { ...t.variants, [p]: v } }))}
          onBack={() => {
            if (step.parts.length > 1 && detail > 0) setDetail(detail - 1);
            else if (stepIndex > 0) enterStep(stepIndex - 1, stepsFor(tpl)[stepIndex - 1].parts.length - 1);
            else {
              // Back from the first part: the summary of what is being marked.
              setQuestion(99);
              setAdvanced(false);
              setPhase('pick');
            }
          }}
          onSkip={(p) => {
            update((t) => ({ ...t, enabled: t.enabled.filter((x) => x !== p), parts: { ...t.parts, [p]: undefined } }));
            // Removing a part can remove its step; stay at the same index (the next step slides in).
            if (step.parts.length === 1 && stepIndex >= steps.length - 1) setPhase('review');
            else if (step.parts.length > 1 && detail >= step.parts.length - 1) {
              if (stepIndex >= steps.length - 1) setPhase('review');
              else enterStep(stepIndex + 1);
            }
          }}
          onNext={() => {
            if (step.parts.length > 1 && detail < step.parts.length - 1) setDetail(detail + 1);
            else if (stepIndex < steps.length - 1) enterStep(stepIndex + 1);
            else setPhase('review');
          }}
        />
      )}

      {phase === 'review' && photo && aspect && (
        <ReviewPhase
          autoPlaced={autoPlaced}
          tpl={tpl}
          c={c}
          uri={photo}
          aspect={aspect}
          width={screenW - EDGE * 2}
          height={Math.round(screenH * 0.36)}
          onEdit={(p) => {
            const i = steps.findIndex((s) => s.parts.includes(p));
            if (i >= 0) enterStep(i, steps[i].parts.indexOf(p));
          }}
          onRect={(p, r) => update((t) => ({ ...t, parts: { ...t.parts, [p]: isBand(p) ? { x: r.x, w: r.w } : r } }))}
          onPlace={(p, r) =>
            update((t) => ({
              ...t,
              enabled: t.enabled.includes(p) ? t.enabled : [...t.enabled, p],
              parts: { ...t.parts, [p]: isBand(p) ? { x: r.x, w: r.w } : r },
            }))
          }
          onRemove={(p) => update((t) => ({ ...t, enabled: t.enabled.filter((x) => x !== p), parts: { ...t.parts, [p]: undefined } }))}
          onVariant={(p, v) => update((t) => ({ ...t, variants: { ...t.variants, [p]: v } }))}
          lines={current?.lines ?? null}
          onAdd={() => {
            setAdvanced(true);
            setPhase('pick');
          }}
          onTest={() => setPhase('test')}
          onSave={async () => {
            await save(tpl);
            router.back();
          }}
        />
      )}

      {phase === 'test' && photo && (
        <TestPhase
          tpl={tpl}
          c={c}
          onRemove={(p) => update((t) => ({ ...t, enabled: t.enabled.filter((x) => x !== p), parts: { ...t.parts, [p]: undefined } }))}
          onFix={(p) => {
            const i = steps.findIndex((s) => s.parts.includes(p));
            if (i >= 0) enterStep(i, steps[i].parts.indexOf(p));
            else setPhase('review');
          }}
          onBack={() => setPhase('review')}
          onSave={async (result) => {
            const saved = await save({ ...tpl, test: result });
            if (isUsable(saved) && !benchId) await setActiveTemplate(db, saved.id);
            router.back();
          }}
        />
      )}
      {(phase === 'mark' || phase === 'review') && (!photo || !aspect) && (
        <View style={base.content}>
          <T muted>Loading the photo…</T>
        </View>
      )}
    </SafeAreaView>
  );
}

function Stepper({ phase, c, fraction }: { phase: Phase; c: Colors; fraction: number }) {
  const at = PHASES.findIndex((p) => p.key.includes(phase));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${at + 1} of 4: ${PHASES[at].label}`}
      style={[styles.stepper]}>
      {PHASES.map((p, i) => (
        <View key={p.label} style={{ flex: 1, gap: 6 }}>
          <View style={[styles.bar, { backgroundColor: c.border }]}>
            <View
              style={{
                height: '100%',
                borderRadius: 3,
                backgroundColor: c.accent,
                width: i < at ? '100%' : i === at ? `${Math.max(0.12, phase === 'mark' ? fraction : phase === 'test' ? 1 : 0.5) * 100}%` : '0%',
              }}
            />
          </View>
          <T style={{ fontSize: 12, fontFamily: i === at ? fonts.bodyBold : fonts.bodyMedium, color: i === at ? c.text : c.muted }}>
            {p.label}
          </T>
        </View>
      ))}
    </View>
  );
}

/** How this book writes a part (e.g. fouls as crossed boxes, a total, or tallies). */
function VariantPicker({ part, value, onChange, c }: { part: PartId; value?: string; onChange: (v: string) => void; c: Colors }) {
  const variants = partSpec(part).variants ?? [];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={`How ${partSpec(part).name.toLowerCase()} are written`} style={{ gap: 6 }}>
      <T style={{ fontSize: 13, fontFamily: fonts.bodyBold }}>How does this book write it?</T>
      {variants.map((v) => {
        const on = v.id === value;
        return (
          <Pressable
            key={v.id}
            onPress={() => onChange(v.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.chooserRow, { borderRadius: 12, borderWidth: on ? 2 : 1, borderColor: on ? PART_COLORS[part] : c.border, backgroundColor: c.card, paddingHorizontal: 12 }]}>
            <View style={{ flex: 1 }}>
              <T style={{ fontFamily: fonts.bodySemiBold }}>{v.name}</T>
              <T muted style={{ fontSize: 12.5 }}>{v.sub}</T>
            </View>
            <T style={{ color: on ? PART_COLORS[part] : c.muted, fontFamily: fonts.bodyBold }}>{on ? '●' : '○'}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "What is this box?": the region bank, with the best guesses from nearby printed labels first. */
function RegionChooser({
  rect,
  lines,
  tpl,
  c,
  onPick,
  onCancel,
}: {
  rect: NormRect;
  lines: TextLine[] | null;
  tpl: ScorebookTemplate;
  c: Colors;
  onPick: (p: PartId) => void;
  onCancel: () => void;
}) {
  const hasRows = !!tpl.parts.rows;
  const suggested = lines ? suggestParts(rect, lines).slice(0, 2) : [];
  const row = (p: PartId, hint?: string) => {
    const spec = partSpec(p);
    const placed = !!tpl.parts[p] && tpl.enabled.includes(p);
    const blocked = spec.shape === 'band' && !hasRows;
    return (
      <Pressable
        key={`${hint ?? ''}${p}`}
        disabled={blocked}
        onPress={() => onPick(p)}
        accessibilityRole="button"
        accessibilityLabel={spec.name}
        style={[styles.chooserRow, blocked && { opacity: 0.4 }]}>
        <View style={[styles.swatchSmall, { backgroundColor: PART_COLORS[p] }]} />
        <View style={{ flex: 1 }}>
          {hint && <T style={{ fontSize: 11.5, fontFamily: fonts.bodyBold, color: c.accent }}>{hint}</T>}
          <T style={{ fontFamily: fonts.bodySemiBold }}>{spec.name}</T>
          <T muted style={{ fontSize: 12.5 }}>
            {blocked ? 'Mark Player rows first: this is a column of the player table.' : placed ? 'Already placed: picking it moves it here.' : spec.short}
          </T>
        </View>
        <StatusChip status={spec.status} c={c} />
      </Pressable>
    );
  };
  return (
    <View style={[base.content, { paddingTop: 0 }]}>
      <View style={[styles.chooser, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={[base.row, { justifyContent: 'space-between' }]}>
          <T style={base.h2}>What is this box?</T>
          <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8}>
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Cancel</T>
          </Pressable>
        </View>
        {suggested.map((p) => row(p, 'SUGGESTED FROM THE PRINTED LABEL'))}
        {PART_GROUPS.map((g) => (
          <View key={g.group} style={{ gap: 2 }}>
            <T style={[styles.groupTitle, { color: c.muted, marginTop: 6 }]}>{g.title}</T>
            {PARTS.filter((p) => p.group === g.group).map((p) => row(p.id))}
          </View>
        ))}
      </View>
    </View>
  );
}

function WhyCard({ text, c }: { text: string; c: Colors }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={[styles.why, { backgroundColor: c.accent + '1F' }]}>
      <T style={{ fontSize: 13, fontFamily: fonts.bodyBold, color: c.accent }}>{`Why InkStat needs this ${open ? '\u25B4' : '\u25BE'}`}</T>
      {open && <T style={{ fontSize: 14, lineHeight: 20 }}>{text}</T>}
    </Pressable>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <View style={styles.footer}>{children}</View>;
}

// ── Phase 1: photo and name ────────────────────────────────────────────────

function PhotoPhase({
  tpl,
  c,
  aspect,
  width,
  onName,
  onPhoto,
  onNext,
}: {
  tpl: ScorebookTemplate;
  c: Colors;
  aspect: number | null;
  width: number;
  onName: (n: string) => void;
  onPhoto: (uri: string) => void;
  onNext: () => void;
}) {
  const dialog = useDialog();
  const pick = async (source: 'camera' | 'library') => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      quality: 1,
      allowsEditing: Platform.OS === 'android',
    };
    if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      void dialog.notice('Camera access needed', 'Allow camera access in Settings, or choose a photo instead.');
      return;
    }
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (!r.canceled) onPhoto(r.assets[0].uri);
  };
  return (
    <>
      <ScrollView contentContainerStyle={[base.content, { gap: space.md }]} keyboardShouldPersistTaps="handled">
        <T style={base.h1}>Start with one clear photo</T>
        <T muted>Use a page that is already filled in. InkStat tests the template on it at the end, so you see right away whether it works.</T>
        {tpl.photoUri && aspect ? (
          <Image source={{ uri: tpl.photoUri }} style={{ width, height: width / aspect, borderRadius: 12 }} resizeMode="contain" />
        ) : (
          <View style={[styles.photoEmpty, { borderColor: c.border, backgroundColor: c.sunken }]}>
            <T muted>No photo yet</T>
          </View>
        )}
        <View style={base.row}>
          <View style={{ flex: 1 }}>
            <Button title={tpl.photoUri ? 'Retake' : 'Camera'} kind={tpl.photoUri ? 'secondary' : 'primary'} onPress={() => pick('camera')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Photos" kind="secondary" onPress={() => pick('library')} />
          </View>
        </View>
        <View style={{ gap: 8 }}>
          {['Flat page, good light, no shadows', 'Whole page fills the frame', 'Shoot later games the same way'].map((tip) => (
            <View key={tip} style={styles.tip}>
              <T style={{ color: c.ok, fontFamily: fonts.bodyBold, width: 20 }}>✓</T>
              <T style={{ flex: 1, fontSize: 15, lineHeight: 21 }}>{tip}</T>
            </View>
          ))}
        </View>
        <View style={{ gap: 6 }}>
          <T style={{ fontFamily: fonts.bodySemiBold }}>Template name</T>
          <TextInput
            value={tpl.name}
            onChangeText={onName}
            accessibilityLabel="Template name"
            placeholder="Wilson red book"
            placeholderTextColor={c.muted}
            style={[styles.input, { borderColor: c.border, backgroundColor: c.card, color: c.text }]}
          />
          <T muted style={base.small}>{'Name it after the book, like "Wilson red book".'}</T>
        </View>
      </ScrollView>
      <Footer>
        <Button title="Use this photo" onPress={onNext} disabled={!tpl.photoUri || !tpl.name.trim()} />
      </Footer>
    </>
  );
}

// ── Phase 2: choose parts ───────────────────────────────────────────────────

function PickPhase({
  tpl,
  c,
  onToggle,
  onBack,
  onNext,
  onAuto,
  placing,
}: {
  tpl: ScorebookTemplate;
  c: Colors;
  onToggle: (p: PartId, on: boolean) => void;
  onBack: () => void;
  onNext: () => void;
  onAuto: () => void;
  placing: boolean;
}) {
  const steps = stepsFor(tpl);
  return (
    <>
      <ScrollView contentContainerStyle={[base.content, { gap: space.sm }]}>
        <T style={base.h1}>What should InkStat read?</T>
        <T muted>{'Turn off anything your book doesn\u2019t have. Each part adds about a second to every scan. The label shows how well InkStat reads it today.'}</T>
        {PART_GROUPS.map((g) => {
          const ready = PARTS.filter((p) => p.group === g.group && p.status !== 'planned');
          const later = PARTS.filter((p) => p.group === g.group && p.status === 'planned');
          return (
            <View key={g.group} style={{ gap: 6, marginTop: space.sm }}>
              <T style={[styles.groupTitle, { color: c.muted }]}>{g.title}</T>
              <View style={[styles.list, { backgroundColor: c.card, borderColor: c.border }]}>
                {ready.map((p, i) => {
                  const required = REQUIRED_PARTS.includes(p.id);
                  const on = tpl.enabled.includes(p.id);
                  return (
                    <View key={p.id} style={[styles.pickRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}>
                      <View style={[styles.swatch, { backgroundColor: PART_COLORS[p.id] }]} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <View style={[base.row, { gap: 6 }]}>
                          <T style={{ fontFamily: fonts.bodySemiBold }}>{p.name}</T>
                          <StatusChip status={p.status} c={c} />
                        </View>
                        <T muted style={{ fontSize: 13, lineHeight: 18 }}>{p.short}</T>
                      </View>
                      {required ? (
                        <T muted style={base.small}>Always</T>
                      ) : (
                        <Switch
                          value={on}
                          onValueChange={(v) => onToggle(p.id, v)}
                          accessibilityLabel={p.name}
                          trackColor={{ true: c.accent, false: c.border }}
                        />
                      )}
                    </View>
                  );
                })}
              </View>
              {later.length > 0 && (
                <T muted style={{ fontSize: 12.5, lineHeight: 18 }}>{`Coming soon: ${later.map((p) => p.name).join(', ')}. You can already box these on Review; they\u2019re kept with the template.`}</T>
              )}
            </View>
          );
        })}
      </ScrollView>
      <Footer>
        <Button title={placing ? 'Finding the printed labels…' : 'Place the boxes for me'} onPress={onAuto} disabled={placing} />
        <View style={[base.row, { marginTop: 6 }]}>
          <View style={{ flex: 1 }}>
            <Button title="Back" kind="secondary" onPress={onBack} />
          </View>
          <View style={{ flex: 2 }}>
            <Button title={`Mark ${steps.length} parts myself`} kind="secondary" onPress={onNext} />
          </View>
        </View>
      </Footer>
    </>
  );
}

// ── Phase 3: mark each part ─────────────────────────────────────────────────

function MarkPhase({
  tpl,
  step,
  stepNumber,
  stepCount,
  found,
  detail,
  onDetail,
  c,
  uri,
  aspect,
  width,
  height,
  onRect,
  onVariant,
  onBack,
  onSkip,
  onNext,
}: {
  tpl: ScorebookTemplate;
  step: Step;
  stepNumber: number;
  stepCount: number;
  found: (p: PartId) => boolean;
  detail: number;
  onDetail: (i: number) => void;
  c: Colors;
  uri: string;
  aspect: number;
  width: number;
  height: number;
  onRect: (p: PartId, r: NormRect) => void;
  onVariant: (p: PartId, v: string) => void;
  onBack: () => void;
  onSkip: (p: PartId) => void;
  onNext: () => void;
}) {
  const part = step.parts[detail];
  const spec = partSpec(part);
  const rect = fullRect(tpl, part);
  const rows = (tpl.parts.rows ?? DEFAULT_PARTS.rows) as NormRect;
  const band = isBand(part) ? { y: rows.y, h: rows.h } : null;
  const optional = !REQUIRED_PARTS.includes(part);

  // Everything else already marked, faint, for context.
  const shapes: MarkerShape[] = markedParts(tpl)
    .filter((p) => p !== part)
    .map((p) => ({ id: p, rect: fullRect(tpl, p)!, color: PART_COLORS[p] }));

  const nextLabel = (() => {
    if (step.parts.length > 1 && detail < step.parts.length - 1) return `Looks right · next: ${partSpec(step.parts[detail + 1]).name.toLowerCase()}`;
    if (stepNumber < stepCount) return 'Looks right · next';
    return 'Looks right · finish';
  })();

  // What InkStat will see for the player table: its columns joined, top few rows.
  const previewBands = (['names', 'fouls', 'points'] as PartId[])
    .filter((p) => tpl.enabled.includes(p) && tpl.parts[p])
    .map((p) => fullRect(tpl, p)!)
    .sort((a, b) => a.x - b.x)
    .map((r) => ({ ...r, h: r.h * 0.22 }));

  return (
    <>
      <ScrollView contentContainerStyle={{ paddingBottom: space.md }}>
        <View style={[base.content, { gap: 6, paddingBottom: space.sm }]}>
          <View style={[base.row, { justifyContent: 'space-between' }]}>
            <View style={[base.row, { gap: 10, flex: 1 }]}>
              <View style={[styles.swatchBig, { backgroundColor: PART_COLORS[part] }]} />
              <T style={base.h1}>{step.parts.length > 1 ? 'Game details' : spec.name}</T>
            </View>
            <T muted style={[base.small, { fontFamily: fonts.mono }]}>{`Part ${stepNumber} of ${stepCount}`}</T>
          </View>
          {step.parts.length > 1 && (
            <View accessibilityRole="tablist" style={[base.row, { gap: 6, flexWrap: 'wrap' }]}>
              {step.parts.map((p, i) => (
                <Pressable
                  key={p}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: i === detail }}
                  onPress={() => onDetail(i)}
                  style={[
                    styles.chip,
                    { borderColor: i === detail ? PART_COLORS[p] : c.border, backgroundColor: i === detail ? c.card : 'transparent' },
                  ]}>
                  <View style={[styles.swatchSmall, { backgroundColor: PART_COLORS[p] }]} />
                  <T style={{ fontSize: 13, fontFamily: i === detail ? fonts.bodyBold : fonts.bodySemiBold }}>{partSpec(p).name}</T>
                </Pressable>
              ))}
            </View>
          )}
          {spec.variants && (
            <VariantPicker part={part} value={variantOf(tpl, part)} onChange={(v) => onVariant(part, v)} c={c} />
          )}
          <View style={[base.row, { alignItems: 'flex-start', gap: space.md, marginTop: 4 }]}>
            <View style={{ flex: 1, gap: 6 }}>
              <T style={{ fontSize: 16, lineHeight: 22, fontFamily: fonts.bodySemiBold }}>
                {part === 'fouls' && variantOf(tpl, 'fouls') === 'total' ? 'Drag across the F total column only.' : spec.instruction}
              </T>
              {found(part) ? (
                <T style={{ fontSize: 13.5, lineHeight: 19, color: c.ok, fontFamily: fonts.bodySemiBold }}>
                  {'\u2713 InkStat placed this box from the printed labels. Check it, then tap Looks right.'}
                </T>
              ) : (
                <T muted style={{ fontSize: 13.5, lineHeight: 19 }}>
                  The box starts where most scoresheets put it. Drag it onto the same thing on your page.
                </T>
              )}
            </View>
            <View style={{ alignItems: 'center', gap: 2 }}>
              <PageHint parts={[part]} width={64} />
              <T muted style={{ fontSize: 11 }}>Usually here</T>
            </View>
          </View>
        </View>

        <View style={styles.markerWrap}>
        <PageMarker
          uri={uri}
          aspect={aspect}
          width={width}
          height={height}
          shapes={shapes}
          active={rect ? { id: part, rect, color: PART_COLORS[part] } : null}
          band={band}
          onChange={(r) => onRect(part, r)}
        />
        </View>

        <View style={[base.content, { gap: space.sm, paddingTop: space.sm }]}>
          <T muted style={base.small}>Drag the box or its corners. Pinch or double-tap to zoom, then drag the page to look around.</T>
          {isBand(part) && previewBands.length > 1 && (
            <View style={{ gap: 6 }}>
              <T style={{ fontSize: 13, fontFamily: fonts.bodyBold }}>What InkStat will see</T>
              <View style={[styles.preview, { borderColor: c.border }]}>
                {previewBands.map((r, i) => (
                  <View key={i} style={{ flexDirection: 'row' }}>
                    {i > 0 && <View style={{ width: 4, backgroundColor: '#282828' }} />}
                    <PhotoCrop uri={uri} aspect={aspect} rect={r} height={64} />
                  </View>
                ))}
              </View>
            </View>
          )}
          {!isBand(part) && rect && part !== 'rows' && (
            <View style={{ gap: 6 }}>
              <T style={{ fontSize: 13, fontFamily: fonts.bodyBold }}>What InkStat will see</T>
              <View style={[styles.preview, { borderColor: c.border, alignSelf: 'flex-start' }]}>
                <PhotoCrop uri={uri} aspect={aspect} rect={rect} height={Math.min(72, 72)} />
              </View>
            </View>
          )}
          <WhyCard text={spec.why} c={c} />
        </View>
      </ScrollView>
      <Footer>
        <View style={base.row}>
          <View style={{ flex: 1 }}>
            <Button title="Back" kind="secondary" onPress={onBack} />
          </View>
          <View style={{ flex: 2 }}>
            <Button title={nextLabel} onPress={onNext} />
          </View>
        </View>
        {optional && (
          <Pressable onPress={() => onSkip(part)} style={styles.skip} accessibilityRole="button">
            <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>{`Skip: my book doesn’t have ${spec.name.toLowerCase()}`}</T>
          </Pressable>
        )}
      </Footer>
    </>
  );
}

// ── Phase 4a: review ────────────────────────────────────────────────────────

function ReviewPhase({
  autoPlaced,
  tpl,
  c,
  uri,
  aspect,
  width,
  height,
  onEdit,
  onAdd,
  onTest,
  onSave,
  onRect,
  onPlace,
  onRemove,
  onVariant,
  lines,
}: {
  autoPlaced: { parts: PartId[]; recognised: string | null } | null;
  tpl: ScorebookTemplate;
  c: Colors;
  uri: string;
  aspect: number;
  width: number;
  height: number;
  onEdit: (p: PartId) => void;
  onRect: (p: PartId, r: NormRect) => void;
  onPlace: (p: PartId, r: NormRect) => void;
  onRemove: (p: PartId) => void;
  onVariant: (p: PartId, v: string) => void;
  lines: TextLine[] | null;
  onAdd: () => void;
  onTest: () => void;
  onSave: () => void;
}) {
  const marked = markedParts(tpl);
  // Adding a region: draw a box, then say what it is (the region bank).
  const [adding, setAdding] = useState<NormRect | null>(null);
  const [choosing, setChoosing] = useState(false);
  const usable = isUsable(tpl);
  // The box being adjusted in place; tap a box (or its name below) to pick it.
  const [selected, setSelected] = useState<PartId | null>(null);
  const sel = selected && marked.includes(selected) ? selected : null;
  const rows = (tpl.parts.rows ?? DEFAULT_PARTS.rows) as NormRect;
  return (
    <>
      <ScrollView contentContainerStyle={{ paddingBottom: space.md }}>
        <View style={[base.content, { gap: 4, paddingBottom: space.sm }]}>
          <T style={base.h1}>Does this look right?</T>
          <T muted>Tap a box to move or resize it right here.</T>
        </View>
        {autoPlaced && (
          <View style={[base.content, { paddingTop: 0 }]}>
            <Card style={{ backgroundColor: c.accent + '1F', borderColor: c.accent }}>
              <T style={{ fontFamily: fonts.bodyBold, color: c.accent }}>
                {autoPlaced.recognised
                  ? `Recognised: ${autoPlaced.recognised}`
                  : `InkStat placed ${autoPlaced.parts.length} of ${tpl.enabled.length} parts from the printed labels`}
              </T>
              <T style={{ fontSize: 14, lineHeight: 20 }}>
                {autoPlaced.recognised
                  ? 'Every box comes from this book\u2019s built-in template, lined up to your photo. Check them, then run the test read.'
                  : autoPlaced.parts.length < tpl.enabled.length
                    ? `Check every box, especially ${tpl.enabled.filter((p) => !autoPlaced.parts.includes(p)).map((p) => partSpec(p).name.toLowerCase()).join(', ')}: those are only a guess. Then run the test read.`
                    : 'Check every box, then run the test read to see what InkStat reads with them.'}
              </T>
            </Card>
          </View>
        )}
        <View style={styles.markerWrap}>
        <PageMarker
          uri={uri}
          aspect={aspect}
          width={width}
          height={height}
          shapes={marked
            .filter((p) => adding || p !== sel)
            .map((p) => ({ id: p, rect: fullRect(tpl, p)!, color: PART_COLORS[p], label: partSpec(p).name }))}
          active={
            adding
              ? { id: 'new', rect: adding, color: c.text }
              : sel
                ? { id: sel, rect: fullRect(tpl, sel)!, color: PART_COLORS[sel], label: partSpec(sel).name }
                : null
          }
          band={!adding && sel && isBand(sel) ? { y: rows.y, h: rows.h } : null}
          onChange={adding ? (r) => setAdding(r) : sel ? (r) => onRect(sel, r) : undefined}
          onTapShape={adding ? undefined : (id) => setSelected(id as PartId)}
          allowDraw={!!adding}
          showLabels
        />
        </View>
        {adding && !choosing && (
          <View style={[base.content, { gap: 8 }]}>
            <T style={{ fontFamily: fonts.bodySemiBold }}>Draw or drag the box over the part, then say what it is.</T>
            <View style={base.row}>
              <View style={{ flex: 1 }}>
                <Button title="Cancel" kind="secondary" onPress={() => setAdding(null)} />
              </View>
              <View style={{ flex: 2 }}>
                <Button title="What is this box?" onPress={() => setChoosing(true)} />
              </View>
            </View>
          </View>
        )}
        {adding && choosing && (
          <RegionChooser
            rect={adding}
            lines={lines}
            tpl={tpl}
            c={c}
            onCancel={() => {
              setChoosing(false);
              setAdding(null);
            }}
            onPick={(p) => {
              // A column of the player table keeps the drawn left edge and width; it spans the rows.
              onPlace(p, adding);
              setChoosing(false);
              setAdding(null);
              setSelected(p);
            }}
          />
        )}
        {!adding && sel && (
          <View style={[base.content, base.row, styles.editing, { borderColor: PART_COLORS[sel] }]}>
            <View style={[styles.swatchSmall, { backgroundColor: PART_COLORS[sel] }]} />
            <T style={{ flex: 1, fontFamily: fonts.bodySemiBold }}>{`Adjusting ${partSpec(sel).name.toLowerCase()}`}</T>
            <Pressable onPress={() => onEdit(sel)} accessibilityRole="button" hitSlop={8} style={styles.editingAction}>
              <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Instructions</T>
            </Pressable>
            {!REQUIRED_PARTS.includes(sel) && (
              <Pressable
                onPress={() => {
                  onRemove(sel);
                  setSelected(null);
                }}
                accessibilityRole="button"
                hitSlop={8}
                style={styles.editingAction}>
                <T style={{ color: c.error, fontFamily: fonts.bodySemiBold }}>Remove</T>
              </Pressable>
            )}
            <Pressable onPress={() => setSelected(null)} accessibilityRole="button" hitSlop={8} style={styles.editingAction}>
              <T style={{ color: c.accent, fontFamily: fonts.bodyBold }}>Done</T>
            </Pressable>
          </View>
        )}
        {!adding && sel && partSpec(sel).variants && (
          <View style={[base.content, { paddingTop: 6 }]}>
            <VariantPicker part={sel} value={variantOf(tpl, sel)} onChange={(v) => onVariant(sel, v)} c={c} />
          </View>
        )}
        <View style={[base.content, styles.grid]}>
          {marked.map((p) => (
            <Pressable
              key={p}
              onPress={() => setSelected(p)}
              accessibilityRole="button"
              accessibilityState={{ selected: p === sel }}
              accessibilityLabel={`Adjust ${partSpec(p).name}`}
              style={[styles.gridItem, { backgroundColor: c.card, borderColor: p === sel ? PART_COLORS[p] : c.border, borderWidth: p === sel ? 2 : 1 }]}>
              <View style={[styles.swatchSmall, { backgroundColor: PART_COLORS[p] }]} />
              <View style={{ flex: 1 }}>
                <T style={{ fontSize: 14, fontFamily: fonts.bodySemiBold }}>{partSpec(p).name}</T>
                {partSpec(p).variants && (
                  <T muted style={{ fontSize: 12 }}>{partSpec(p).variants!.find((v) => v.id === variantOf(tpl, p))?.name ?? ''}</T>
                )}
              </View>
              <StatusChip status={partSpec(p).status} c={c} />
            </Pressable>
          ))}
          <Pressable
            onPress={() => {
              setSelected(null);
              setChoosing(false);
              setAdding({ x: 0.35, y: 0.4, w: 0.25, h: 0.08 });
            }}
            accessibilityRole="button"
            style={[styles.gridItem, { borderColor: c.accent, borderStyle: 'dashed' }]}>
            <T style={{ flex: 1, fontSize: 14, fontFamily: fonts.bodySemiBold, color: c.accent }}>+ Add a region</T>
          </Pressable>
          <Pressable onPress={onAdd} accessibilityRole="button" style={[styles.gridItem, { borderColor: c.border }]}>
            <T style={{ flex: 1, fontSize: 14, fontFamily: fonts.bodySemiBold, color: c.accent }}>Choose from the list</T>
          </Pressable>
        </View>
        {!usable && (
          <View style={base.content}>
            <Card style={{ backgroundColor: c.warnBg, borderColor: c.warnLine }}>
              <T style={{ color: c.warn, fontFamily: fonts.bodyBold }}>Player rows, names and points must all be marked before this template can read pages.</T>
            </Card>
          </View>
        )}
      </ScrollView>
      <Footer>
        <Button title="Test read this photo" onPress={onTest} disabled={!usable} />
        <Pressable onPress={onSave} style={styles.skip} accessibilityRole="button">
          <T style={{ color: c.accent, fontFamily: fonts.bodySemiBold }}>Save without testing</T>
        </Pressable>
      </Footer>
    </>
  );
}

// ── Phase 4b: test read ─────────────────────────────────────────────────────

const KEEP_AWAKE_TAG = 'inkstat-template-test';

function TestPhase({
  tpl,
  c,
  onFix,
  onRemove,
  onBack,
  onSave,
}: {
  tpl: ScorebookTemplate;
  c: Colors;
  onFix: (p: PartId) => void;
  /** Drop a part that can't be read from the template, without re-reading. */
  onRemove: (p: PartId) => void;
  onBack: () => void;
  onSave: (result: NonNullable<ScorebookTemplate['test']>) => void;
}) {
  const db = useSQLiteContext();
  const [progress, setProgress] = useState<{ fraction: number; text: string; rect?: NormRect | null } | null>({ fraction: 0, text: 'Starting…' });
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [checks, setChecks] = useState<PartCheck[] | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Read with the template as it was when this screen opened: removing a part
  // afterwards drops its line here instead of starting the read again.
  const [readWith] = useState(tpl);
  const [removed, setRemoved] = useState<PartId[]>([]);

  useEffect(() => {
    const tpl = readWith;
    const ctrl = new AbortController();
    abort.current = ctrl;
    (async () => {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
      try {
        const modelId = await getActiveModelId(db);
        const doc = applyTemplate(SCOREBOOK_PAGE_TEMPLATE, tpl);
        const run = await extract(modelId, tpl.photoUri!, doc, {
          signal: ctrl.signal,
          onModelLoad: (f) => setProgress({ fraction: f * 0.1, text: 'Loading the reading model…' }),
          onProgress: (p) => {
            const label = doc.regions.find((r) => r.id === p.regionId)?.label ?? '';
            setProgress({
              fraction: (p.done + (p.phase === 'writing' ? 0.6 : 0.1)) / Math.max(1, p.total),
              text: label ? `Reading ${label.toLowerCase()}…` : 'Finishing…',
              rect: p.phase === 'finished' ? null : progressRect(doc, p),
            });
          },
        });
        for (const r of run.results) console.log(`[template-test] raw ${r.regionId}#${r.tileIndex}: ${r.raw.replace(/\s+/g, ' ').slice(0, 800)}`);
        if (ctrl.signal.aborted) return;
        setSeconds(Math.round((run.finishedAt - run.startedAt) / 100) / 10);
        setChecks(templateChecks(tpl, readPage(run)));
        setProgress(null);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setProgress(null);
        }
      } finally {
        await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      }
    })();
    return () => ctrl.abort();
  }, [db, readWith]);

  if (progress) {
    return (
      <View style={[base.content, { flex: 1, justifyContent: 'center', gap: space.md }]}>
        {readWith.photoUri && (
          <ReadingView uri={readWith.photoUri} rect={progress.rect ?? null} width={screenW - space.lg * 2} height={Math.round(screenH * 0.42)} />
        )}
        <T style={base.h2}>{progress.text}</T>
        <ProgressBar fraction={progress.fraction} />
        <T muted>Reading your photo with this template. Nothing is saved as a game.</T>
        <Button
          title="Cancel"
          kind="secondary"
          onPress={() => {
            abort.current?.abort();
            onBack();
          }}
        />
      </View>
    );
  }

  if (error || !checks) {
    return (
      <View style={[base.content, { flex: 1, justifyContent: 'center', gap: space.md }]}>
        <T style={base.h2}>The test read failed</T>
        <T muted>{error ?? 'Unknown error'}</T>
        <Button title="Back to review" onPress={onBack} />
      </View>
    );
  }

  const shown = checks.filter((k) => !removed.includes(k.part));
  const problems = shown.filter((k) => !k.ok);
  return (
    <>
      <ScrollView contentContainerStyle={[base.content, { gap: space.md }]}>
        <T style={base.h1}>{'Here’s what InkStat read'}</T>
        <View style={[base.row, { gap: 8, flexWrap: 'wrap' }]}>
          <T style={[styles.pill, { backgroundColor: c.okBg, color: c.ok }]}>{`${shown.length - problems.length} look right`}</T>
          {problems.length > 0 && <T style={[styles.pill, { backgroundColor: c.warnBg, color: c.warn }]}>{`${problems.length} to check`}</T>}
          <T style={[styles.pill, { backgroundColor: c.sunken, color: c.muted, fontFamily: fonts.mono }]}>{`${seconds} s`}</T>
        </View>
        {problems.map((k) => (
          <Card key={k.part} style={{ backgroundColor: c.warnBg, borderColor: c.warnLine }}>
            <T style={{ color: c.warn, fontFamily: fonts.bodyBold }}>{`${partSpec(k.part).name}: ${k.value}`}</T>
            <T style={{ fontSize: 14, lineHeight: 20 }}>{k.note ?? ''}</T>
            <View style={[base.row, { gap: 20 }]}>
              <Pressable onPress={() => onFix(k.part)} accessibilityRole="button" style={{ minHeight: 40, justifyContent: 'center' }}>
                <T style={{ color: c.accent, fontFamily: fonts.bodyBold }}>{`Redo ${partSpec(k.part).name.toLowerCase()}`}</T>
              </Pressable>
              {!REQUIRED_PARTS.includes(k.part) && (
                <Pressable
                  onPress={() => {
                    onRemove(k.part);
                    setRemoved((r) => [...r, k.part]);
                  }}
                  accessibilityRole="button"
                  accessibilityHint="InkStat stops reading this part on this scorebook"
                  style={{ minHeight: 40, justifyContent: 'center' }}>
                  <T style={{ color: c.error, fontFamily: fonts.bodySemiBold }}>Remove this part</T>
                </Pressable>
              )}
            </View>
          </Card>
        ))}
        <View style={[styles.list, { backgroundColor: c.card, borderColor: c.border }]}>
          {shown.map((k, i) => (
            <Pressable
              key={k.part}
              onPress={() => onFix(k.part)}
              accessibilityRole="button"
              accessibilityLabel={`${partSpec(k.part).name}: ${k.value}. ${k.ok ? 'Looks right' : 'Check this'}. Tap to redo.`}
              style={[styles.checkRow, i > 0 && { borderTopWidth: 1, borderTopColor: c.border }, !k.ok && { backgroundColor: c.warnBg }]}>
              <View style={[styles.swatchSmall, { backgroundColor: PART_COLORS[k.part] }]} />
              <T muted style={{ width: 96, fontSize: 13 }}>{partSpec(k.part).name}</T>
              <T style={{ flex: 1, fontFamily: fonts.mono, fontSize: 14 }}>{k.value}</T>
              <T style={{ color: k.ok ? c.ok : c.warn, fontFamily: fonts.bodyBold }}>{k.ok ? '✓' : '!'}</T>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <Footer>
        <View style={base.row}>
          <View style={{ flex: 1 }}>
            <Button title="Fix a part" kind="secondary" onPress={onBack} />
          </View>
          <View style={{ flex: 2 }}>
            <Button
              title="Save template"
              onPress={() => onSave({ at: Date.now(), seconds, checks: shown.length, problems: problems.length })}
            />
          </View>
        </View>
      </Footer>
    </>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', gap: 6, paddingHorizontal: space.lg, paddingTop: space.sm },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  why: { borderRadius: 14, padding: 14, gap: 4 },
  status: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, overflow: 'hidden', fontSize: 11, fontFamily: fonts.bodyBold },
  chooser: { borderRadius: 16, borderWidth: 1, padding: 12, gap: 8, marginTop: space.sm },
  chooserRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 4 },
  editing: { marginTop: space.sm, marginHorizontal: space.lg, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1.5, borderRadius: 12, gap: 10 },
  editingAction: { minHeight: 36, justifyContent: 'center' },
  markerWrap: { marginHorizontal: EDGE, borderRadius: 12, overflow: 'hidden' },
  tip: { flexDirection: 'row', alignItems: 'flex-start' },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md, gap: 4 },
  photoEmpty: { height: 200, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontSize: 16, fontFamily: fonts.body },
  groupTitle: { fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.8, textTransform: 'uppercase' },
  list: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  swatchBig: { width: 16, height: 16, borderRadius: 4 },
  swatchSmall: { width: 10, height: 10, borderRadius: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1.5 },
  segment: { flexDirection: 'row', borderRadius: 12, padding: 4 },
  segmentItem: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  preview: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start', backgroundColor: '#FFFFFF' },
  skip: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: space.sm },
  gridItem: { width: '48.5%', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 44 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden', fontSize: 13, fontFamily: fonts.bodySemiBold },
});

/** The page layout passed from a scan, if it parses. */
function parseSheet(json: string): ScorebookTemplate['sheet'] {
  try {
    const v = JSON.parse(json) as ScorebookTemplate['sheet'];
    return v && (v.teams === 'one' || v.teams === 'both') ? v : undefined;
  } catch {
    return undefined;
  }
}
