import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatWhen } from '../../lib/format';
import { useSync } from '../../lib/sync/SyncProvider';
import type { ServerSyncStatus } from '../../lib/types';
import { Banner, Body, Button, Card, Divider, Pill, Row, Screen, Title } from '../../components/ui';

export default function SyncStatus() {
  const { user } = useAuth();
  const { state, syncing, syncNow, access, backgroundEnabled, contacts } = useSync();
  const [server, setServer] = useState<ServerSyncStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ServerSyncStatus>('/api/contacts/sync/status').then(setServer).catch(() => setServer(null));
  }, []);
  useFocusEffect(load);

  const run = async (confirmMassDelete = false) => {
    setMsg(await syncNow({ confirmMassDelete }));
    load();
  };

  const accessText = { granted: 'Allowed', denied: 'Denied (change in Settings)', undetermined: 'Not asked yet', unavailable: 'Not available on this device' }[access];

  return (
    <Screen>
      <Title sub="The cloud copy is what USSD shows. It only changes when a sync succeeds.">Sync status</Title>
      {msg ? <Banner kind="error" title="Sync failed">{msg}</Banner> : null}
      {state?.needsMassDeleteConfirm ? (
        <Banner kind="warn" title="Confirm large deletion" action={<Button compact kind="danger" title="Yes, delete them from the cloud" onPress={() => run(true)} />}>
          Most of the contacts synced from this phone are missing from its phonebook. If you really deleted them, confirm to remove them from your account too.
        </Banner>
      ) : null}
      {state?.lastStats?.suspiciousEmptyRead ? (
        <Banner kind="warn">Your phonebook looked empty on the last sync, so nothing was deleted from the cloud.</Banner>
      ) : null}
      <Card>
        <Row title="Cloud (what USSD sees)" right={<Pill text={server?.status ?? '…'} kind={server?.status === 'success' ? 'ok' : server?.status === 'error' ? 'error' : 'info'} />} />
        <Body>Last successful sync: {formatWhen(server?.lastSuccessfulSyncAt)}</Body>
        <Body>Contacts in account: {server?.totalContacts ?? '—'}</Body>
        {server?.lastError ? <Banner kind="error">{server.lastError}</Banner> : null}
      </Card>
      <Card>
        <Row title="This phone" right={<Pill text={syncing ? 'syncing' : state?.lastError ? 'error' : state?.lastSyncAt ? 'ok' : 'never'} kind={state?.lastError ? 'error' : state?.lastSyncAt ? 'ok' : 'warn'} />} />
        <Body>Last phonebook sync: {formatWhen(state?.lastSyncAt)}</Body>
        <Body>Last refreshed from cloud: {formatWhen(state?.lastRefreshAt)}</Body>
        <Body>Last attempt: {formatWhen(state?.lastAttemptAt)}</Body>
        <Body>Contacts on this phone (cached): {contacts.length}</Body>
        <Body>Phonebook access: {accessText}</Body>
        <Body>Cloud upload consent: {user?.contactsConsentAt ? 'Given' : 'Not given'}</Body>
        <Body>Background sync: {backgroundEnabled ? 'Scheduled (the OS decides when it runs)' : 'Off — syncs when you open the app'}</Body>
        {state?.lastStats ? (
          <Body muted>
            Last run: {state.lastStats.created ?? 0} new, {state.lastStats.updated ?? 0} updated, {state.lastStats.deleted ?? 0} deleted, {state.lastStats.conflict ?? 0} conflicts (server copy kept), {state.lastStats.skippedNoNumber ?? 0} without numbers skipped.
          </Body>
        ) : null}
        {state?.lastError ? <Banner kind="error">{state.lastError}</Banner> : null}
      </Card>
      {server?.devices.length ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>Devices</Body>
          {server.devices.map((d, i) => (
            <View key={d.deviceId}>
              {i > 0 ? <Divider /> : null}
              <Row title={d.name ?? d.platform} subtitle={`${d.status} · ${formatWhen(d.lastSuccessfulSyncAt)}`} />
            </View>
          ))}
        </Card>
      ) : null}
      <Button title="Sync now" onPress={() => run()} loading={syncing} />
      {access !== 'granted' || !user?.contactsConsentAt ? <Button title="Set up phonebook sync" kind="secondary" onPress={() => router.push('/permission')} /> : null}
    </Screen>
  );
}
