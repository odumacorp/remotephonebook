import React from 'react';
import { Banner } from './ui';
import { useSync } from '../lib/sync/SyncProvider';

export function OfflineBanner() {
  const { online } = useSync();
  if (online) return null;
  return <Banner kind="warn" title="You're offline">Showing contacts saved on this phone. Changes will sync when you reconnect.</Banner>;
}
