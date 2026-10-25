import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { api, configureApi } from '../api';
import { BACKGROUND_SYNC_MINUTES } from '../config';
import { secure } from '../storage';
import type { User } from '../types';
import { deviceAccess, runSync } from './engine';

export const BACKGROUND_SYNC_TASK = 'rpb-background-sync';

/**
 * Background sync. The OS decides when (and whether) this runs: at least every
 * BACKGROUND_SYNC_MINUTES on Android (WorkManager), opportunistically on iOS (BGTaskScheduler,
 * often only overnight/while charging). Foreground sync on app open is the reliable path.
 */
if (Platform.OS !== 'web') {
  TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
    try {
      const token = await secure.get('rpb.session');
      if (!token) return BackgroundTask.BackgroundTaskResult.Success;
      configureApi({ getToken: () => token, onUnauthorized: () => {} });
      const me = await api<User>('/api/account', { retries: 1 });
      if (!me.contactsConsentAt) return BackgroundTask.BackgroundTaskResult.Success;
      await runSync(me.id, { includeDevice: (await deviceAccess()) === 'granted' });
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function enableBackgroundSync(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    if (!(await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK))) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: BACKGROUND_SYNC_MINUTES });
    }
    return true;
  } catch {
    return false;
  }
}

export async function disableBackgroundSync() {
  if (Platform.OS === 'web') return;
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK).catch(() => false)) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}
