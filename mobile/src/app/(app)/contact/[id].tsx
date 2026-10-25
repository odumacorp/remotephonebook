import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { api, errorMessage } from '../../../lib/api';
import { useSync } from '../../../lib/sync/SyncProvider';
import { useTheme } from '../../../lib/theme';
import type { Contact } from '../../../lib/types';
import { NumberActions } from '../../../components/NumberActions';
import { Avatar, Banner, Body, Button, Card, Divider, Empty, Pill, Screen } from '../../../components/ui';

export default function ContactDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, removeLocal, upsertLocal } = useSync();
  const cached = state?.contacts[id];
  const [contact, setContact] = useState<Contact | undefined>(cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Refresh from the server (falls back to the offline copy).
    api<Contact>(`/api/contacts/${id}`, { retries: 0 })
      .then((c) => {
        setContact(c);
        void upsertLocal(c);
        void api(`/api/contacts/${id}/accessed`, { method: 'POST', retries: 0 }).catch(() => {});
      })
      .catch((err) => {
        if (err?.status === 404) setError('This contact no longer exists.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!contact) return <Screen><Empty title={error ?? 'Contact not found'} /></Screen>;

  const remove = async () => {
    const go = async () => {
      try {
        await api(`/api/contacts/${id}`, { method: 'DELETE' });
        await removeLocal(id);
        router.back();
      } catch (err) {
        setError(errorMessage(err));
      }
    };
    const note = contact.fromThisDevice ? ' It stays in your phone\'s own address book.' : '';
    // eslint-disable-next-line no-alert
    if (Platform.OS === 'web') return window.confirm(`Delete ${contact.displayName}?${note}`) && go();
    Alert.alert('Delete contact?', `Remove ${contact.displayName} from RemotePhonebook?${note}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: go },
    ]);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: contact.displayName }} />
      <View style={{ alignItems: 'center', gap: 8, paddingVertical: 8 }}>
        <Avatar name={contact.displayName} demo={contact.isDemo} />
        <Text style={{ fontSize: 24, fontWeight: '700', color: t.text, textAlign: 'center' }}>{contact.displayName}</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {contact.isDemo ? <Pill text="DEMO · NOT A REAL NUMBER" kind="warn" /> : null}
          {contact.fromThisDevice ? <Pill text="From this phone" /> : null}
        </View>
      </View>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Card>
        {contact.numbers.map((n, i) => (
          <View key={n.id} style={{ gap: 8, paddingVertical: 6 }}>
            {i > 0 ? <Divider /> : null}
            <Text style={{ color: t.muted, fontSize: 13, textTransform: 'capitalize' }}>{n.label ?? 'phone'}{n.isPrimary && contact.numbers.length > 1 ? ' · primary' : ''}</Text>
            <Text selectable style={{ color: t.text, fontSize: 22, fontWeight: '600', letterSpacing: 0.5 }}>{n.formatted}</Text>
            <NumberActions name={contact.displayName} number={n.normalized} demo={contact.isDemo} />
          </View>
        ))}
      </Card>
      <Body muted>Over USSD this contact appears under "View Contacts" with the same numbers.</Body>
      <Button title="Edit" kind="secondary" onPress={() => router.push({ pathname: '/contact/edit', params: { id } })} />
      <Button title="Delete" kind="ghost" onPress={remove} />
    </Screen>
  );
}
