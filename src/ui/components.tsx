import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { fonts, radius, space, useColors } from './theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle | ViewStyle[] }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, style]}>{children}</View>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  size = 'md',
  disabled,
  busy,
  icon,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'dangerSolid';
  size?: 'md' | 'lg';
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
}) {
  const c = useColors();
  const bg = kind === 'primary' ? c.accent : kind === 'dangerSolid' ? c.error : 'transparent';
  const fg = kind === 'primary' || kind === 'dangerSolid' ? c.accentText : kind === 'danger' ? c.error : c.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        size === 'lg' && styles.buttonLg,
        { backgroundColor: bg, borderColor: kind === 'primary' || kind === 'dangerSolid' ? bg : fg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
      ]}>
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon}
          <Text style={[styles.buttonText, size === 'lg' && { fontSize: 18 }, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function ProgressBar({ fraction }: { fraction: number }) {
  const c = useColors();
  return (
    <View style={[styles.track, { backgroundColor: c.sunken }]}>
      <View
        style={[styles.fill, { backgroundColor: c.accent, width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }]}
      />
    </View>
  );
}

/** Themed text. Body font by default; pass a base style (base.h2, base.num...) to change it. */
export function T({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: TextStyle | (TextStyle | false | undefined)[] }) {
  const c = useColors();
  return <Text style={[{ color: muted ? c.muted : c.text, fontFamily: fonts.body, fontSize: 15 }, style]}>{children}</Text>;
}

export type BadgeTone = 'warn' | 'error' | 'ok' | 'waiting';

export function Badge({ tone, label }: { tone: BadgeTone; label: string }) {
  const c = useColors();
  const [bg, fg] =
    tone === 'warn' ? [c.warnBg, c.warn] : tone === 'error' ? [c.errorBg, c.error] : tone === 'waiting' ? [c.sunken, c.muted] : [c.okBg, c.ok];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontFamily: fonts.bodySemiBold, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function StatusDot({ tone }: { tone: 'ok' | 'warn' }) {
  const c = useColors();
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone === 'ok' ? c.ok : c.warnLine }} />;
}

export const formatBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: space.sm },
  button: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  buttonLg: { minHeight: 64, borderRadius: radius.xl },
  buttonText: { fontSize: 16, fontFamily: fonts.bodySemiBold },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8 },
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-end' },
});
