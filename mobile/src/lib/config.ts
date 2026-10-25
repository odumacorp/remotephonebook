import Constants from 'expo-constants';

/** API base URL: EXPO_PUBLIC_API_URL wins, then app.json "extra.apiUrl". */
export const API_URL: string = (
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'http://localhost:4000'
).replace(/\/$/, '');

export const USSD_CODE = process.env.EXPO_PUBLIC_USSD_CODE ?? '*123#';

/** Dev-only screens (USSD simulator) are hidden in production builds. */
export const DEV_TOOLS = __DEV__;

export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const BACKGROUND_SYNC_MINUTES = 60;
export const SYNC_CHUNK_SIZE = 200;
