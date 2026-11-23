import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type NativeTouchEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { T } from './components';
import { fonts, space } from './theme';

export interface Photo {
  uri: string;
  label: string;
  /** The whole page photo, as opposed to a crop of it. */
  page?: boolean;
}

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 280;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: NativeTouchEvent, b: NativeTouchEvent) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
const mid = (a: NativeTouchEvent, b: NativeTouchEvent) => ({ x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 });

/**
 * One photo with pinch to zoom, drag to pan while zoomed, and double tap to
 * zoom in on a spot or back out. Built on PanResponder so it needs no native
 * gesture library. At 1x, single-finger swipes are left to the pager.
 */
function ZoomablePhoto({
  uri,
  width,
  height,
  onZoomedChange,
}: {
  uri: string;
  width: number;
  height: number;
  onZoomedChange: (zoomed: boolean) => void;
}) {
  const [scale] = useState(() => new Animated.Value(1));
  const [tx] = useState(() => new Animated.Value(0));
  const [ty] = useState(() => new Animated.Value(0));
  // Committed values (Animated.Value can't be read synchronously) and the current gesture's baseline.
  const view = useRef({ s: 1, x: 0, y: 0 });
  const gesture = useRef({ s: 1, x: 0, y: 0, d: 0, cx: 0, cy: 0, touches: 0, moved: false });
  const lastTap = useRef(0);
  const latest = useRef({ width, height, onZoomedChange });
  useLayoutEffect(() => {
    latest.current = { width, height, onZoomedChange };
  });

  const responder = useMemo(() => {
    // Keep the photo covering the screen: no panning past its edges.
    const bound = (s: number, x: number, y: number) => {
      const { width: w, height: h } = latest.current;
      const mx = (w * (s - 1)) / 2;
      const my = (h * (s - 1)) / 2;
      return { x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
    };
    const apply = (s: number, x: number, y: number) => {
      const b = bound(s, x, y);
      view.current = { s, x: b.x, y: b.y };
      scale.setValue(s);
      tx.setValue(b.x);
      ty.setValue(b.y);
    };
    const animateTo = (s: number, x: number, y: number) => {
      const b = bound(s, x, y);
      view.current = { s, x: b.x, y: b.y };
      latest.current.onZoomedChange(s > 1.01);
      Animated.parallel([
        Animated.spring(scale, { toValue: s, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(tx, { toValue: b.x, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(ty, { toValue: b.y, useNativeDriver: true, bounciness: 0 }),
      ]).start();
    };
    // Start of a gesture, or the finger count changed mid-gesture: re-baseline.
    const baseline = (e: GestureResponderEvent) => {
      const t = e.nativeEvent.touches;
      const g = gesture.current;
      g.s = view.current.s;
      g.x = view.current.x;
      g.y = view.current.y;
      g.touches = t.length;
      if (t.length >= 2) {
        g.d = dist(t[0], t[1]);
        const m = mid(t[0], t[1]);
        g.cx = m.x;
        g.cy = m.y;
      } else if (t.length === 1) {
        g.cx = t[0].pageX;
        g.cy = t[0].pageY;
      }
    };
    const wantsTouch = (e: GestureResponderEvent) =>
      e.nativeEvent.touches.length >= 2 || view.current.s > 1.01;

    // Refs are read only inside touch callbacks, never during render; the lint rule
    // cannot see that through PanResponder.create (same as useDrag in the layout editor).
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      // Claim taps too, so double tap works; a lone swipe at 1x is released to the pager below.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (e) => wantsTouch(e),
      onPanResponderGrant: (e) => {
        gesture.current.moved = false;
        baseline(e);
      },
      onPanResponderMove: (e) => {
        const t = e.nativeEvent.touches;
        const g = gesture.current;
        if (t.length !== g.touches) baseline(e);
        if (t.length >= 2) {
          const d = dist(t[0], t[1]);
          const m = mid(t[0], t[1]);
          const s = clamp((g.s * d) / Math.max(1, g.d), 1, MAX_SCALE);
          // Keep the point between the fingers under the fingers while scaling.
          const { width: w, height: h } = latest.current;
          const px = g.cx - w / 2;
          const py = g.cy - h / 2;
          const k = s / g.s;
          g.moved = true;
          apply(s, px - k * (px - g.x) + (m.x - g.cx), py - k * (py - g.y) + (m.y - g.cy));
        } else if (t.length === 1) {
          const dx = t[0].pageX - g.cx;
          const dy = t[0].pageY - g.cy;
          if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
          if (view.current.s > 1.01) apply(view.current.s, g.x + dx, g.y + dy);
        }
      },
      onPanResponderRelease: (e) => {
        const { s } = view.current;
        if (!gesture.current.moved) {
          // eslint-disable-next-line react-hooks/purity -- runs on touch release, not during render
          const now = Date.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0;
            if (s > 1.01) animateTo(1, 0, 0);
            else {
              // Zoom in on the tapped spot.
              const { width: w, height: h } = latest.current;
              const px = e.nativeEvent.pageX - w / 2;
              const py = e.nativeEvent.pageY - h / 2;
              animateTo(DOUBLE_TAP_SCALE, -px * (DOUBLE_TAP_SCALE - 1), -py * (DOUBLE_TAP_SCALE - 1));
            }
            return;
          }
          lastTap.current = now;
        }
        if (s < 1.05) animateTo(1, 0, 0);
        else latest.current.onZoomedChange(true);
      },
      // At 1x, let the native pager intercept a swipe; zoomed, keep it for panning.
      onShouldBlockNativeResponder: () => view.current.s > 1.01,
      // At 1x a horizontal swipe belongs to the pager.
      onPanResponderTerminationRequest: () => view.current.s <= 1.01,
      onPanResponderTerminate: () => {
        if (view.current.s < 1.05) animateTo(1, 0, 0);
      },
    }).panHandlers;
  }, [scale, tx, ty]);

  return (
    <View style={{ width, height, overflow: 'hidden' }} {...responder}>
      <Animated.Image
        source={{ uri }}
        resizeMode="contain"
        style={{ width, height, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

/**
 * Full-screen viewer for a game's page photo and crops: swipe or use the
 * arrows to move between them, pinch or double tap to zoom.
 */
export function PhotoViewer({
  photos,
  index,
  onClose,
}: {
  photos: Photo[];
  /** Photo to open on, or null when closed. */
  index: number | null;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [at, setAt] = useState(index ?? 0);
  const [zoomed, setZoomed] = useState(false);
  const list = useRef<FlatList<Photo>>(null);

  // Opening on a new photo: jump there. (Each photo resets its own zoom when it remounts.)
  const [openedAt, setOpenedAt] = useState(index);
  if (index !== openedAt) {
    setOpenedAt(index);
    if (index !== null) {
      setAt(index);
      setZoomed(false);
    }
  }

  const page = photos.findIndex((p) => p.page);

  const go = (i: number) => {
    const next = clamp(i, 0, photos.length - 1);
    list.current?.scrollToIndex({ index: next, animated: true });
    setAt(next);
    setZoomed(false);
  };

  return (
    <Modal visible={index !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        {index !== null && (
          <FlatList
            ref={list}
            data={photos}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed}
            initialScrollIndex={index}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            showsHorizontalScrollIndicator={false}
            keyExtractor={(p) => p.uri}
            onMomentumScrollEnd={(e) => {
              setAt(Math.round(e.nativeEvent.contentOffset.x / width));
              setZoomed(false);
            }}
            renderItem={({ item, index: i }) => (
              <ZoomablePhoto
                // Remount when the page changes away, so an old zoom doesn't linger.
                key={`${item.uri}-${i === at ? 'on' : 'off'}`}
                uri={item.uri}
                width={width}
                height={height}
                onZoomedChange={setZoomed}
              />
            )}
          />
        )}

        <SafeAreaView style={styles.top} edges={['top']} pointerEvents="box-none">
          <View style={styles.bar}>
            <View style={{ flex: 1 }}>
              <T style={styles.light}>{photos[at]?.label ?? ''}</T>
              <T style={[styles.light, styles.dim]}>{`${at + 1} of ${photos.length}`}</T>
            </View>
            {/* A crop can be too small to settle a value: one tap to the whole page photo. */}
            {page >= 0 && at !== page && (
              <Pressable onPress={() => go(page)} style={styles.pill} accessibilityRole="button" accessibilityLabel="See the whole page">
                <T style={[styles.light, { fontFamily: fonts.bodySemiBold, fontSize: 14 }]}>Whole page</T>
              </Pressable>
            )}
            <Pressable onPress={onClose} style={styles.button} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
              <T style={styles.glyph}>✕</T>
            </Pressable>
          </View>
        </SafeAreaView>

        <SafeAreaView style={styles.bottom} edges={['bottom']} pointerEvents="box-none">
          <View style={styles.bar}>
            <Pressable
              onPress={() => go(at - 1)}
              disabled={at === 0}
              style={[styles.button, at === 0 && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Previous photo">
              <T style={styles.glyph}>‹</T>
            </Pressable>
            <T style={[styles.light, styles.dim, { flex: 1, textAlign: 'center' }]}>
              {zoomed ? 'Double tap to zoom out' : 'Pinch or double tap to zoom'}
            </T>
            <Pressable
              onPress={() => go(at + 1)}
              disabled={at === photos.length - 1}
              style={[styles.button, at === photos.length - 1 && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Next photo">
              <T style={styles.glyph}>›</T>
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', top: 0, left: 0, right: 0 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  light: { color: '#FFFFFF' },
  dim: { opacity: 0.7, fontSize: 13 },
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  off: { opacity: 0.3 },
  pill: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  glyph: { color: '#FFFFFF', fontSize: 24, lineHeight: 28, fontFamily: fonts.bodySemiBold },
});
