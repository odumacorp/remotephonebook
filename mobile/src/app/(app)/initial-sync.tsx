import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSync } from '../../lib/sync/SyncProvider';
import { useTheme } from '../../lib/theme';
import { Banner, Body, Button, Card, Screen, Title } from '../../components/ui';

export default function InitialSync() {
  const t = useTheme();
  const { syncNow, progress, contacts, state } = useSync();
  const [result, setResult] = useState<'running' | 'done' | string>('running');

  const start = async () => {
    setResult('running');
    const err = await syncNow();
    setResult(err ?? 'done');
  };

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phaseText = !progress ? 'Preparing…'
    : progress.phase === 'pulling' ? 'Checking your account…'
    : progress.phase === 'reading' ? `Reading your phonebook… ${progress.done || ''}`
    : progress.phase === 'uploading' ? `Uploading ${progress.done} of ${progress.total}…`
    : 'Finishing…';

  return (
    <Screen>
      <Title sub="This first sync uploads your whole phonebook. Later syncs only send changes.">Syncing your contacts</Title>
      <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
        {result === 'running' ? (
          <>
            <ActivityIndicator size="large" color={t.primary} />
            <Body>{phaseText}</Body>
            {progress?.phase === 'uploading' && progress.total > 0 ? (
              <View style={{ height: 8, width: '100%', backgroundColor: t.border, borderRadius: 4, overflow: 'hidden' }}>
                <View style={{ height: 8, width: `${Math.round((progress.done / progress.total) * 100)}%`, backgroundColor: t.primary }} />
              </View>
            ) : null}
          </>
        ) : result === 'done' ? (
          <>
            <Body style={{ fontSize: 40 }}>✓</Body>
            <Body style={{ fontWeight: '700' }}>{contacts.length} contacts synced</Body>
            {state?.lastStats?.skippedNoNumber ? <Body muted>{state.lastStats.skippedNoNumber} entries without a phone number were skipped.</Body> : null}
          </>
        ) : (
          <Banner kind="error" title="Sync didn't finish">{result}</Banner>
        )}
      </Card>
      {result === 'done' ? <Button title="Go to my contacts" onPress={() => router.replace('/home')} /> : null}
      {result !== 'done' && result !== 'running' ? (
        <>
          <Button title="Try again" onPress={start} />
          <Button title="Continue without syncing" kind="ghost" onPress={() => router.replace('/home')} />
        </>
      ) : null}
    </Screen>
  );
}
