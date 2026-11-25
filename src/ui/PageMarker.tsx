import type { NormRect } from '@inkstat/ocr-engine';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type NativeTouchEvent,
} from 'react-native';
import Svg, { Polygon } from 'react-native-svg';

import { T } from './components';
import { fonts } from './theme';

export interface MarkerShape {
  id: string;
  /** Full rect on the page, normalized 0..1 (bands pass their rows-box height). */
  rect: NormRect;
  color: string;
  label?: string;
  /** A band that leans: how far its left edge moves sideways from top to bottom (fraction of the page). */
  lean?: number;
}

const MAX_SCALE = 6;
const HIT = 24; // touch tolerance for handles, in screen px
const MIN_DRAW = 0.01; // smallest box a drag can draw, as a fraction of the page

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Distances use screen (page) coordinates: with several fingers down, Android can report
// each finger's locationX relative to a different view, which made zoom and pan jump.
const dist = (a: NativeTouchEvent, b: NativeTouchEvent) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

type Mode =
  | { kind: 'none' }
  | { kind: 'zoom'; s: number; tx: number; ty: number; d: number; cx: number; cy: number }
  | { kind: 'pan'; tx: number; ty: number; sx: number; sy: number }
  | { kind: 'draw'; x0: number; y0: number }
  | { kind: 'move'; start: NormRect; lean: number; x0: number; y0: number }
  | { kind: 'resize'; start: NormRect; lean: number; hx: 0 | 1 | null; hy: 0 | 1 | null; x0: number; y0: number }
  | { kind: 'lean'; start: NormRect; lean: number; end: 'top' | 'bottom'; x0: number };

/** Where a leaning shape's left edge is at page height y. */
const leftAt = (r: NormRect, lean: number, y: number) => r.x + lean * clamp((y - r.y) / Math.max(1e-6, r.h), 0, 1);
const inside = (r: NormRect, lean: number, p: { x: number; y: number }) =>
  p.y >= r.y && p.y <= r.y + r.h && p.x >= leftAt(r, lean, p.y) && p.x <= leftAt(r, lean, p.y) + r.w;

/** A finger must travel this far (screen px) before it changes anything: taps and pinch starts stay harmless. */
const SLOP = 8;
/** Space between the viewport edge and the page at 1x, in screen px. */
const PAD = 14;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * A page photo to mark boxes on.
 * - One finger on the box moves it; on a corner (a band: an edge) resizes it.
 * - A band also has a handle in the middle of its top and bottom edges: drag one
 *   sideways to make the column lean, for a tilted photo or an uneven printed column.
 * - One finger elsewhere draws a new box at 1x, and pans the page when zoomed in.
 *   With nothing active, the new box goes to `onDraw` when the finger lifts.
 * - Two fingers pinch to zoom and pan; whatever the first finger changed is undone.
 * - Double tap zooms in on that spot, or back out.
 * Positions are reported as fractions of the page.
 */
export function PageMarker({
  uri,
  aspect,
  width,
  height,
  shapes,
  active,
  band,
  onChange,
  showLabels = false,
  onTapShape,
  allowDraw = true,
  onDraw,
}: {
  uri: string;
  /** Photo width / height. */
  aspect: number;
  width: number;
  height: number;
  /** Everything drawn on the page; the active one (if any) is editable. */
  shapes: MarkerShape[];
  active?: MarkerShape | null;
  /** When set, the active shape is a band: only x and width change, y and height come from here. */
  band?: { y: number; h: number } | null;
  /** A band's change also gives its lean. */
  onChange?: (rect: NormRect, lean?: number) => void;
  showLabels?: boolean;
  /** A tap (not a drag) on a shape: lets a screen make that shape the active one. */
  onTapShape?: (id: string) => void;
  /** One finger on empty paper draws a new box (true) or only pans when zoomed (false). */
  allowDraw?: boolean;
  /** With nothing active, a box drawn on empty paper is handed here when the finger lifts. */
  onDraw?: (rect: NormRect) => void;
}) {
  // Fit the page in the viewport at 1x.
  // A margin inside the frame keeps handles on the page's own edges whole and easy to grab.
  const iw = width - PAD * 2;
  const ih = height - PAD * 2;
  const fit = aspect >= iw / ih ? { w: iw, h: iw / aspect } : { w: ih * aspect, h: ih };
  const off = { x: (width - fit.w) / 2, y: (height - fit.h) / 2 };
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  // A box being drawn when nothing is active: shown while the finger is down, then given to onDraw.
  const [draft, setDraft] = useState<NormRect | null>(null);

  const latest = useRef({ view, fit, off, width, height, active, band, onChange, shapes, onTapShape, allowDraw, onDraw });
  useLayoutEffect(() => {
    latest.current = { view, fit, off, width, height, active, band, onChange, shapes, onTapShape, allowDraw, onDraw };
  });
  const mode = useRef<Mode>({ kind: 'none' });

  const responder = useMemo(() => {
    const toPage = (sx: number, sy: number) => {
      const { view: v, fit: f, off: o } = latest.current;
      return { x: ((sx - v.tx) / v.s - o.x) / f.w, y: ((sy - v.ty) / v.s - o.y) / f.h };
    };
    const toScreen = (nx: number, ny: number) => {
      const { view: v, fit: f, off: o } = latest.current;
      return { x: v.tx + v.s * (o.x + nx * f.w), y: v.ty + v.s * (o.y + ny * f.h) };
    };
    const boundView = (s: number, tx: number, ty: number) => {
      const { width: w, height: h } = latest.current;
      // Content is w x h at scale 1; keep it covering the viewport.
      return { s, tx: clamp(tx, w - w * s, 0), ty: clamp(ty, h - h * s, 0) };
    };
    const emit = (r: NormRect, lean = 0) => {
      const b = latest.current.band;
      const x = clamp(r.x, 0, 1);
      const y = clamp(r.y, 0, 1);
      const out = { x, y, w: clamp(r.w, 0.005, 1 - x), h: clamp(r.h, 0.005, 1 - y) };
      if (!b) return latest.current.onChange?.(out);
      // The bottom of a leaning band stays on the page too.
      const l = clamp(out.x + lean, 0, Math.max(0, 1 - out.w)) - out.x;
      latest.current.onChange?.({ x: out.x, w: out.w, y: b.y, h: b.h }, l);
    };

    // The gesture's starting state: put back if a second finger turns it into a pinch.
    const gesture = { startRect: null as NormRect | null, startLean: 0, x0: 0, y0: 0, moved: false, lastTap: 0, draft: null as NormRect | null };
    const setDrafted = (r: NormRect | null) => {
      gesture.draft = r;
      setDraft(r);
    };
    // Where the viewport sits on screen, taken from the first finger of each gesture
    // (one finger's locationX is reliable); every position after that is pageX - origin.
    const origin = { x: 0, y: 0 };
    const lx = (t: NativeTouchEvent) => t.pageX - origin.x;
    const ly = (t: NativeTouchEvent) => t.pageY - origin.y;
    const mid = (a: NativeTouchEvent, b: NativeTouchEvent) => ({ x: (lx(a) + lx(b)) / 2, y: (ly(a) + ly(b)) / 2 });

    const startZoom = (t: readonly NativeTouchEvent[]) => {
      if (gesture.moved && gesture.startRect && latest.current.onChange) emit(gesture.startRect, gesture.startLean);
      gesture.moved = true; // a pinch is never a tap
      if (gesture.draft) setDrafted(null);
      const v = latest.current.view;
      const m = mid(t[0], t[1]);
      mode.current = { kind: 'zoom', s: v.s, tx: v.tx, ty: v.ty, d: dist(t[0], t[1]), cx: m.x, cy: m.y };
    };

    const startOne = (t: NativeTouchEvent) => {
      const a = latest.current.active;
      const v = latest.current.view;
      const p = toPage(lx(t), ly(t));
      gesture.startRect = a?.rect ?? null;
      gesture.startLean = a?.lean ?? 0;
      gesture.x0 = lx(t);
      gesture.y0 = ly(t);
      gesture.moved = false;
      const pan: Mode = { kind: 'pan', tx: v.tx, ty: v.ty, sx: lx(t), sy: ly(t) };
      if (!a || !latest.current.onChange) {
        const drawNew = !a && latest.current.onDraw && latest.current.allowDraw && v.s <= 1.01;
        mode.current = drawNew ? { kind: 'draw', x0: p.x, y0: p.y } : pan;
        return;
      }
      const r = a.rect;
      const isBand = !!latest.current.band;
      const lean = isBand ? (a.lean ?? 0) : 0;
      // A band's sides are where its edges cross the finger's height.
      const edgeY = clamp(p.y, r.y, r.y + r.h);
      const tl = toScreen(leftAt(r, lean, edgeY), r.y);
      const br = toScreen(leftAt(r, lean, edgeY) + r.w, r.y + r.h);
      const near = (val: number, edge: number) => Math.abs(val - edge) <= HIT;
      const hx = near(lx(t), tl.x) ? 0 : near(lx(t), br.x) ? 1 : null;
      const hy = isBand ? null : near(ly(t), tl.y) ? 0 : near(ly(t), br.y) ? 1 : null;
      const inY = ly(t) >= tl.y - HIT && ly(t) <= br.y + HIT;
      const top = toScreen(r.x + r.w / 2, r.y);
      const bottom = toScreen(r.x + lean + r.w / 2, r.y + r.h);
      const onHandle = (q: { x: number; y: number }) => Math.hypot(lx(t) - q.x, ly(t) - q.y) <= HIT * 1.25;
      if (isBand && (onHandle(top) || onHandle(bottom))) {
        mode.current = { kind: 'lean', start: r, lean, end: onHandle(top) ? 'top' : 'bottom', x0: p.x };
      } else if (isBand ? hx !== null && inY : hx !== null && hy !== null) {
        mode.current = { kind: 'resize', start: r, lean, hx, hy, x0: p.x, y0: p.y };
      } else if (inside(r, lean, p)) {
        mode.current = { kind: 'move', start: r, lean, x0: p.x, y0: p.y };
      } else if (v.s > 1.01 || !latest.current.allowDraw) {
        mode.current = pan;
      } else {
        mode.current = { kind: 'draw', x0: p.x, y0: p.y };
      }
    };

    const doubleTap = (sx: number, sy: number) => {
      const v = latest.current.view;
      if (v.s > 1.01) {
        setView({ s: 1, tx: 0, ty: 0 });
        return;
      }
      // Zoom in so the tapped point stays under the finger.
      const s2 = DOUBLE_TAP_SCALE;
      setView(boundView(s2, sx - s2 * sx, sy - s2 * sy));
    };

    // Refs are read only inside touch callbacks, never during render; the lint
    // rule cannot see that through PanResponder.create.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        const t = e.nativeEvent.touches;
        const first = t[0] ?? e.nativeEvent;
        origin.x = first.pageX - first.locationX;
        origin.y = first.pageY - first.locationY;
        if (t.length >= 2) startZoom(t);
        else if (t.length === 1) startOne(t[0]);
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        const t = e.nativeEvent.touches;
        if (t.length >= 2) {
          if (mode.current.kind !== 'zoom') startZoom(t);
          const z = mode.current as Extract<Mode, { kind: 'zoom' }>;
          const m = mid(t[0], t[1]);
          const s = clamp((z.s * dist(t[0], t[1])) / Math.max(1, z.d), 1, MAX_SCALE);
          const k = s / z.s;
          // Keep the content point under the starting midpoint under the current midpoint.
          setView(boundView(s, m.x - k * (z.cx - z.tx), m.y - k * (z.cy - z.ty)));
          return;
        }
        if (t.length !== 1) return;
        const m = mode.current;
        if (m.kind === 'zoom') return; // one finger lifted mid-pinch: wait for the gesture to end
        if (!gesture.moved) {
          if (Math.hypot(lx(t[0]) - gesture.x0, ly(t[0]) - gesture.y0) < SLOP) return;
          gesture.moved = true;
        }
        if (m.kind === 'pan') {
          const v = latest.current.view;
          if (v.s <= 1.01) return; // nothing to pan at 1x
          setView(boundView(v.s, m.tx + lx(t[0]) - m.sx, m.ty + ly(t[0]) - m.sy));
          return;
        }
        const p = toPage(lx(t[0]), ly(t[0]));
        if (m.kind === 'draw') {
          const x = Math.min(m.x0, p.x);
          const y = Math.min(m.y0, p.y);
          const w = Math.abs(p.x - m.x0);
          const h = Math.abs(p.y - m.y0);
          if (!latest.current.active) {
            const r = { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: Math.min(w, 1 - clamp(x, 0, 1)), h: Math.min(h, 1 - clamp(y, 0, 1)) };
            setDrafted(w > MIN_DRAW && h > MIN_DRAW ? r : null);
          } else if (w > MIN_DRAW && (latest.current.band || h > MIN_DRAW)) emit({ x, y, w, h });
        } else if (m.kind === 'move') {
          const r = m.start;
          const x = clamp(r.x + p.x - m.x0, Math.max(0, -m.lean), 1 - r.w - Math.max(0, m.lean));
          emit({ ...r, x, y: clamp(r.y + p.y - m.y0, 0, 1 - r.h) }, m.lean);
        } else if (m.kind === 'lean') {
          // The top handle moves the top edge (the bottom stays put); the bottom handle the bottom.
          const d = p.x - m.x0;
          if (m.end === 'top') emit({ ...m.start, x: m.start.x + d }, m.lean - d);
          else emit(m.start, m.lean + d);
        } else if (m.kind === 'resize') {
          const r = m.start;
          let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
          const dx = p.x - m.x0, dy = p.y - m.y0;
          if (m.hx === 0) x0 = Math.min(x0 + dx, x1 - MIN_DRAW);
          if (m.hx === 1) x1 = Math.max(x1 + dx, x0 + MIN_DRAW);
          if (m.hy === 0) y0 = Math.min(y0 + dy, y1 - MIN_DRAW);
          if (m.hy === 1) y1 = Math.max(y1 + dy, y0 + MIN_DRAW);
          emit({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, m.lean);
        }
      },
      onPanResponderRelease: (e: GestureResponderEvent) => {
        if (gesture.draft) {
          const r = gesture.draft;
          setDrafted(null);
          mode.current = { kind: 'none' };
          latest.current.onDraw?.(r);
          return;
        }
        if (!gesture.moved && mode.current.kind !== 'zoom') {
          const now = e.nativeEvent.timestamp;
          if (now - gesture.lastTap < DOUBLE_TAP_MS) {
            gesture.lastTap = 0;
            doubleTap(gesture.x0, gesture.y0);
          } else {
            gesture.lastTap = now;
            // A single tap on a shape selects it; the smallest one under the finger wins,
            // so a column band inside the rows box can be picked.
            const tap = latest.current.onTapShape;
            if (tap) {
              const p = toPage(gesture.x0, gesture.y0);
              const all = [...latest.current.shapes, ...(latest.current.active ? [latest.current.active] : [])];
              const hit = all
                .filter((sh) => inside(sh.rect, sh.lean ?? 0, p))
                .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0];
              if (hit && hit.id !== latest.current.active?.id) tap(hit.id);
            }
          }
        }
        mode.current = { kind: 'none' };
      },
      onPanResponderTerminate: () => {
        if (gesture.draft) setDrafted(null);
        mode.current = { kind: 'none' };
      },
    }).panHandlers;
  }, []);

  const s = view.s;
  const px = (r: NormRect) => ({
    left: off.x + r.x * fit.w,
    top: off.y + r.y * fit.h,
    width: r.w * fit.w,
    height: r.h * fit.h,
  });
  const handle = 18 / s;
  const activeRect = active?.rect;
  const activeLean = band ? (active?.lean ?? 0) : 0;
  // A band's side handles sit halfway down, where its leaning edges are by then.
  const corners: [number, number][] = band ? [[0, 0.5], [1, 0.5]] : [[0, 0], [1, 0], [0, 1], [1, 1]];
  const at = (x: number, y: number) => `${off.x + x * fit.w},${off.y + y * fit.h}`;
  const quad = (r: NormRect, lean: number) =>
    [at(r.x, r.y), at(r.x + r.w, r.y), at(r.x + lean + r.w, r.y + r.h), at(r.x + lean, r.y + r.h)].join(' ');
  const leaning = (sh: MarkerShape) => Math.abs(sh.lean ?? 0) > 1e-4;

  return (
    <View style={[styles.viewport, { width, height }]} {...responder}>
      <View
        pointerEvents="none"
        style={{
          width,
          height,
          transformOrigin: [0, 0, 0],
          transform: [{ translateX: view.tx }, { translateY: view.ty }, { scale: s }],
        }}>
        <Image source={{ uri }} style={{ position: 'absolute', ...px({ x: 0, y: 0, w: 1, h: 1 }) }} resizeMode="stretch" />
        {/* Leaning columns are drawn as slanted outlines. */}
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          {shapes.filter(leaning).map((sh) => (
            <Polygon key={sh.id} points={quad(sh.rect, sh.lean!)} stroke={sh.color} strokeWidth={1.5 / s} fill={sh.color} fillOpacity={0.1} />
          ))}
          {active && activeRect && activeLean !== 0 && (
            <Polygon points={quad(activeRect, activeLean)} stroke={active.color} strokeWidth={3 / s} fill={active.color} fillOpacity={0.19} />
          )}
        </Svg>
        {shapes.map((sh) => (
          <View
            key={sh.id}
            style={[
              styles.shape,
              px(sh.rect),
              leaning(sh)
                ? null
                : { borderColor: sh.color, borderWidth: 1.5 / s, backgroundColor: sh.color + '1A', borderRadius: 3 / s },
            ]}>
            {/* Names only when they fit: a busy page shows them once zoomed in. One line each. */}
            {showLabels && sh.label && (shapes.length <= 12 || s >= 2) && (
              <Text numberOfLines={1} style={[styles.label, { backgroundColor: sh.color, fontSize: 10 / s, lineHeight: 14 / s, top: -15 / s, paddingHorizontal: 4 / s }]}>
                {sh.label}
              </Text>
            )}
          </View>
        ))}
        {draft && (
          <View
            style={[
              styles.shape,
              px(draft),
              { borderColor: '#FFFFFF', borderStyle: 'dashed', borderWidth: 2.5 / s, backgroundColor: 'rgba(47,93,168,0.25)', borderRadius: 3 / s },
            ]}
          />
        )}
        {active && activeRect && (
          <>
            {activeLean === 0 && (
              <View
                style={[
                  styles.shape,
                  px(activeRect),
                  { borderColor: active.color, borderWidth: 3 / s, backgroundColor: active.color + '30', borderRadius: 3 / s },
                ]}
              />
            )}
            {band &&
              (
                [
                  [activeRect.x + activeRect.w / 2, activeRect.y],
                  [activeRect.x + activeLean + activeRect.w / 2, activeRect.y + activeRect.h],
                ] as const
              ).map(([hx, hy], i) => (
                // Lean handles: wide white pills, to say "drag me sideways".
                <View
                  key={`lean${i}`}
                  style={[
                    styles.handle,
                    {
                      left: off.x + hx * fit.w - handle,
                      top: off.y + hy * fit.h - handle / 2,
                      width: handle * 2,
                      height: handle,
                      borderRadius: handle / 2,
                      borderWidth: 2.5 / s,
                      borderColor: active.color,
                      backgroundColor: '#FFFFFF',
                    },
                  ]}
                />
              ))}
            {corners.map(([cx, cy], i) => (
              <View
                key={i}
                style={[
                  styles.handle,
                  {
                    left: off.x + (activeRect.x + activeLean * cy + cx * activeRect.w) * fit.w - handle / 2,
                    top: off.y + (activeRect.y + cy * activeRect.h) * fit.h - (band ? handle : handle / 2),
                    width: handle,
                    height: band ? handle * 2 : handle,
                    borderRadius: band ? handle / 3 : handle / 2,
                    borderWidth: 2 / s,
                    backgroundColor: active.color,
                  },
                ]}
              />
            ))}
          </>
        )}
      </View>
      {s > 1.01 && (
        <Pressable
          onPress={() => setView({ s: 1, tx: 0, ty: 0 })}
          style={styles.zoomChip}
          accessibilityRole="button"
          accessibilityLabel="Zoom out to the whole page">
          <T style={styles.zoomText}>{`${s.toFixed(1)}× · Reset`}</T>
        </Pressable>
      )}
    </View>
  );
}

/** Part of the photo, shown at a fixed height: what InkStat will be shown for a box. */
export function PhotoCrop({ uri, aspect, rect, height }: { uri: string; aspect: number; rect: NormRect; height: number }) {
  const m = height / Math.max(0.001, rect.h);
  return (
    <View style={{ width: rect.w * aspect * m, height, overflow: 'hidden' }}>
      <Image
        source={{ uri }}
        style={{ position: 'absolute', width: aspect * m, height: m, left: -rect.x * aspect * m, top: -rect.y * m }}
        resizeMode="stretch"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: { overflow: 'hidden', backgroundColor: '#1B2430' },
  shape: { position: 'absolute' },
  label: { position: 'absolute', left: 0, color: '#FFFFFF', fontFamily: fonts.bodyBold, borderRadius: 3 },
  handle: { position: 'absolute', borderColor: '#FFFFFF' },
  zoomChip: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(27,36,48,0.85)',
    justifyContent: 'center',
  },
  zoomText: { color: '#FFFFFF', fontFamily: fonts.mono, fontSize: 13 },
});
