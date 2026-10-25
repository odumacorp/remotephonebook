import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewStyle, type StyleProp,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { space, useTheme } from '../lib/theme';
import { initials } from '../lib/format';

export function Screen({ children, scroll = true, padded = true }: { children: React.ReactNode; scroll?: boolean; padded?: boolean }) {
  const t = useTheme();
  const inner = <View style={[{ maxWidth: 640, width: '100%', alignSelf: 'center' }, padded && { padding: space.lg, gap: space.md }]}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xl }}>{inner}</ScrollView> : inner}
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4, marginBottom: space.sm }}>
      <Text accessibilityRole="header" style={{ fontSize: 26, fontWeight: '700', color: t.text }}>{children}</Text>
      {sub ? <Text style={{ fontSize: 15, color: t.muted, lineHeight: 21 }}>{sub}</Text> : null}
    </View>
  );
}

export function Body({ children, muted, style }: { children: React.ReactNode; muted?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[{ fontSize: 15, lineHeight: 22, color: muted ? t.muted : t.text }, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.card, borderRadius: 14, padding: space.lg, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }, style]}>{children}</View>;
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ title, onPress, kind = 'primary', loading, disabled, accessibilityHint, compact }: {
  title: string; onPress: () => void; kind?: ButtonKind; loading?: boolean; disabled?: boolean; accessibilityHint?: string; compact?: boolean;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.primary : kind === 'danger' ? t.danger : kind === 'secondary' ? t.primarySoft : 'transparent';
  const fg = kind === 'primary' ? t.primaryText : kind === 'danger' ? '#fff' : t.primary;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      accessibilityHint={accessibilityHint}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => ({
        backgroundColor: bg, opacity: off ? 0.55 : pressed ? 0.85 : 1, borderRadius: 12,
        paddingVertical: compact ? 8 : 14, paddingHorizontal: compact ? 12 : 16, minHeight: compact ? 36 : 48,
        alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
      })}
    >
      {loading ? <ActivityIndicator color={fg} /> : null}
      <Text style={{ color: fg, fontSize: compact ? 14 : 16, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, error, hint, ...props }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: t.text }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        {...props}
        style={{
          backgroundColor: t.input, color: t.text, borderWidth: 1, borderColor: error ? t.danger : t.border,
          borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, minHeight: 48,
        }}
      />
      {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : hint ? <Text style={{ color: t.muted, fontSize: 13 }}>{hint}</Text> : null}
    </View>
  );
}

export function Banner({ kind = 'info', title, children, action }: {
  kind?: 'info' | 'warn' | 'error' | 'ok'; title?: string; children?: React.ReactNode; action?: React.ReactNode;
}) {
  const t = useTheme();
  const palette = { info: [t.primarySoft, t.text], warn: [t.warnSoft, t.warn], error: [t.dangerSoft, t.danger], ok: [t.okSoft, t.ok] }[kind];
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: palette[0], borderRadius: 12, padding: space.md, gap: 6 }}>
      {title ? <Text style={{ color: palette[1], fontWeight: '700', fontSize: 15 }}>{title}</Text> : null}
      {typeof children === 'string' ? <Text style={{ color: kind === 'info' ? t.text : palette[1], fontSize: 14, lineHeight: 20 }}>{children}</Text> : children}
      {action}
    </View>
  );
}

export function Avatar({ name, demo }: { name: string; demo?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: demo ? t.warnSoft : t.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: demo ? t.warn : t.primary, fontWeight: '700' }}>{initials(name)}</Text>
    </View>
  );
}

export function Row({ title, subtitle, right, onPress, accessibilityLabel }: {
  title: string; subtitle?: string; right?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12, opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 16, color: t.text, fontWeight: '500' }}>{title}</Text>
        {subtitle ? <Text style={{ fontSize: 13, color: t.muted }}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Text style={{ color: t.muted, fontSize: 20 }}>›</Text> : null)}
    </Pressable>
  );
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} />;
}

export function Pill({ text, kind = 'info' }: { text: string; kind?: 'info' | 'warn' | 'ok' | 'error' }) {
  const t = useTheme();
  const [bg, fg] = { info: [t.primarySoft, t.primary], warn: [t.warnSoft, t.warn], ok: [t.okSoft, t.ok], error: [t.dangerSoft, t.danger] }[kind];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: space.xl, gap: space.sm }}>
      <Text style={{ fontSize: 17, fontWeight: '600', color: t.text, textAlign: 'center' }}>{title}</Text>
      {typeof children === 'string' ? <Text style={{ color: t.muted, textAlign: 'center', lineHeight: 20 }}>{children}</Text> : children}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: t.bg }}>
      <ActivityIndicator size="large" color={t.primary} />
      {label ? <Text style={{ color: t.muted }}>{label}</Text> : null}
    </View>
  );
}
