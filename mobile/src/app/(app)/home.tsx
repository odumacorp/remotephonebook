import { router, Stack } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../lib/auth';
import { DEV_TOOLS, USSD_CODE } from '../../lib/config';
import { formatWhen } from '../../lib/format';
import { useSync } from '../../lib/sync/SyncProvider';
import { space, useTheme } from '../../lib/theme';
import type { Contact } from '../../lib/types';
import { OfflineBanner } from '../../components/OfflineBanner';
import { Avatar, Banner, Button, Card, Empty, Field, Pill } from '../../components/ui';

function ContactItem({ c }: { c: Contact }) {
  const t = useTheme();
  const primary = c.numbers.find((n) => n.isPrimary) ?? c.numbers[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${c.displayName}, ${primary?.formatted ?? 'no number'}`}
      onPress={() => router.push({ pathname: '/contact/[id]', params: { id: c.id } })}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: space.lg, opacity: pressed ? 0.7 : 1 })}
    >
      <Avatar name={c.displayName} demo={c.isDemo} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>{c.displayName}</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>{primary?.formatted}{c.numbers.length > 1 ? `  +${c.numbers.length - 1}` : ''}</Text>
      </View>
      {c.isDemo ? <Pill text="DEMO" kind="warn" /> : null}
    </Pressable>
  );
}

export default function Home() {
  const t = useTheme();
  const { user } = useAuth();
  const { contacts, state, syncing, syncNow, access, progress } = useSync();
  const [q, setQ] = useState('');
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Phonebook sync is only active with both the OS permission and the user's cloud-upload consent.
  const deviceSync = access === 'granted' && Boolean(user?.contactsConsentAt);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contacts;
    const digits = needle.replace(/\D/g, '').replace(/^0+/, '');
    return contacts.filter((c) => c.displayName.toLowerCase().includes(needle) || (digits.length >= 3 && c.numbers.some((n) => n.normalized.includes(digits))));
  }, [contacts, q]);

  const status = syncing
    ? { text: progress?.phase === 'uploading' ? `Uploading ${progress.done}/${progress.total}` : 'Syncing…', kind: 'info' as const }
    : state?.lastError
      ? { text: 'Sync failed', kind: 'error' as const }
      : !deviceSync
        ? { text: 'Cloud copy only', kind: 'info' as const }
        : state?.lastSyncAt
          ? { text: 'Up to date', kind: 'ok' as const }
          : { text: 'Not synced yet', kind: 'warn' as const };

  const header = (
    <View style={{ padding: space.lg, gap: space.md }}>
      <OfflineBanner />
      {!deviceSync ? (
        <Banner kind="info" title="Sync your phonebook" action={<Button compact title={access === 'unavailable' ? 'Learn more' : 'Set up phonebook sync'} onPress={() => router.push('/permission')} />}>
          {access === 'unavailable'
            ? 'This device cannot share its phonebook. You can still add contacts manually or use demo contacts.'
            : `Import your contacts so you can reach them by dialling ${USSD_CODE} from any phone.`}
        </Banner>
      ) : null}
      {state?.lastError && !syncing ? (
        <Banner kind="error" title="Last sync failed" action={<Button compact kind="secondary" title="Details" onPress={() => router.push('/sync-status')} />}>{state.lastError}</Banner>
      ) : null}
      <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable style={{ flex: 1, gap: 4 }} onPress={() => router.push('/sync-status')} accessibilityRole="button" accessibilityLabel="Sync status">
          <Text style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>{contacts.length}</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>
            {deviceSync ? `contacts · phonebook synced ${formatWhen(state?.lastSyncAt)}` : `contacts in your account · refreshed ${formatWhen(state?.lastRefreshAt)}`}
          </Text>
          <Pill text={status.text} kind={status.kind} />
        </Pressable>
        <Button compact title={deviceSync ? 'Sync now' : 'Refresh'} loading={syncing} onPress={async () => setSyncMsg(await syncNow())} />
      </Card>
      {syncMsg && !syncing && !state?.lastError ? <Banner kind="error">{syncMsg}</Banner> : null}
      <Field label="Search contacts" value={q} onChangeText={setQ} placeholder="Name or number" autoCapitalize="none" clearButtonMode="while-editing" />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button compact kind="secondary" title="+ Add contact" onPress={() => router.push('/contact/edit')} />
        <Button compact kind="secondary" title="Import from phone" onPress={() => router.push('/permission')} />
        <Button compact kind="secondary" title="Demo contacts" onPress={() => router.push('/demo')} />
        <Button compact kind="ghost" title="Full search" onPress={() => router.push('/search')} />
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {DEV_TOOLS ? <Button compact kind="ghost" title="USSD" onPress={() => router.push('/ussd-simulator')} /> : null}
            <Button compact kind="ghost" title="Account" onPress={() => router.push('/account')} />
          </View>
        ),
      }} />
      <FlatList
        style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}
        data={filtered}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={header}
        renderItem={({ item }) => <ContactItem c={item} />}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.border, marginLeft: 72 }} />}
        ListEmptyComponent={
          q ? <Empty title="No matches">Try a different name or number, or use Full search.</Empty>
          : syncing ? <Empty title="Loading your contacts…" />
          : <Empty title="No contacts yet">Import your phonebook, add a contact, or load the demo contacts to try things out.</Empty>
        }
        keyboardShouldPersistTaps="handled"
      />
    </SafeAreaView>
  );
}
