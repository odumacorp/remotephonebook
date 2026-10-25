import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Secrets (the session token) live in the OS keychain/keystore via SecureStore.
 * The web build has no keychain, so it falls back to AsyncStorage (localStorage) - acceptable for
 * development only.
 */
export const secure = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return AsyncStorage.getItem(`secure:${key}`);
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') return AsyncStorage.setItem(`secure:${key}`, value);
    return SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') return AsyncStorage.removeItem(`secure:${key}`);
    return SecureStore.deleteItemAsync(key);
  },
};

export async function getJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function removeKeys(prefix: string): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}
