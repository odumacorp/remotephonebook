import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { secure } from './storage';

const KEY = 'rpb.deviceIdentifier';
let cached: string | null = null;

/** A random per-install identifier. Contact source ids are namespaced by it on the server. */
export async function getDeviceIdentifier(): Promise<string> {
  if (cached) return cached;
  let id = await secure.get(KEY);
  if (!id) {
    id = `rpb-${Crypto.randomUUID()}`;
    await secure.set(KEY, id);
  }
  cached = id;
  return id;
}

export async function deviceInfo() {
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'other';
  return {
    deviceIdentifier: await getDeviceIdentifier(),
    platform: platform as 'ios' | 'android' | 'web' | 'other',
    name: (Constants.deviceName ?? `${Platform.OS} device`).slice(0, 80),
  };
}
