import { useColorScheme } from 'react-native';

const light = {
  bg: '#F4F6F8',
  card: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  primary: '#0F766E',
  primaryText: '#FFFFFF',
  primarySoft: '#CCFBF1',
  danger: '#B91C1C',
  dangerSoft: '#FEE2E2',
  warn: '#92400E',
  warnSoft: '#FEF3C7',
  ok: '#15803D',
  okSoft: '#DCFCE7',
  input: '#FFFFFF',
};

const dark: typeof light = {
  bg: '#0B1015',
  card: '#151C24',
  text: '#F3F4F6',
  muted: '#9CA3AF',
  border: '#27313D',
  primary: '#2DD4BF',
  primaryText: '#042F2E',
  primarySoft: '#134E4A',
  danger: '#F87171',
  dangerSoft: '#450A0A',
  warn: '#FCD34D',
  warnSoft: '#422006',
  ok: '#4ADE80',
  okSoft: '#052E16',
  input: '#0F161D',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
