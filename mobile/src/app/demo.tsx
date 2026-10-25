import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DEMO_CONTACTS } from '../lib/demoContacts';
import { useSync } from '../lib/sync/SyncProvider';
import { NumberActions } from '../components/NumberActions';
import { Avatar, Banner, Body, Button, Card, Divider, Field, Pill, Row, Screen, Title } from '../components/ui';

/** Works offline, without login and without contacts permission. */
export default function Demo() {
  const { token } = useAuth();
  const { syncNow, contacts } = useSync();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const alreadyAdded = contacts.some((c) => c.isDemo);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '').replace(/^0/, '');
    return DEMO_CONTACTS.filter((c) => !needle || c.displayName.toLowerCase().includes(needle) || (digits.length >= 3 && c.number.includes(digits)));
  }, [q]);

  const addToAccount = async () => {
    setBusy(true);
    setMsg(null);
    try {
      for (const c of DEMO_CONTACTS) {
        await api('/api/contacts', { method: 'POST', body: { displayName: c.displayName, numbers: [{ number: c.number, label: 'mobile' }], isDemo: true } });
      }
      await syncNow();
      setMsg({ kind: 'ok', text: 'Added 10 demo contacts to your account. They are now available over USSD too.' });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub="Ten fictional contacts for trying the app. No account or contacts permission needed.">Demo contacts</Title>
      <Banner kind="warn">These are test records. The numbers are not real and should not be dialled.</Banner>
      {token ? (
        <Button
          title={alreadyAdded ? 'Demo contacts already in your account' : 'Add demo contacts to my account'}
          kind="secondary" onPress={addToAccount} loading={busy} disabled={alreadyAdded}
          accessibilityHint="Uploads the ten demo contacts so you can test sync and USSD"
        />
      ) : (
        <Button title="Create an account to sync your own contacts" kind="secondary" onPress={() => router.push('/register')} />
      )}
      {msg ? <Banner kind={msg.kind}>{msg.text}</Banner> : null}
      <Field label="Search demo contacts" value={q} onChangeText={setQ} placeholder="Name or number" autoCapitalize="none" />
      <Card style={{ paddingVertical: 4 }}>
        {list.length === 0 ? <Body muted>No demo contacts match.</Body> : null}
        {list.map((c, i) => (
          <View key={c.id}>
            {i > 0 ? <Divider /> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar name={c.displayName} demo />
              <View style={{ flex: 1 }}>
                <Row title={c.displayName} subtitle={c.number} onPress={() => setOpen(open === c.id ? null : c.id)} right={<Pill text="DEMO" kind="warn" />} />
              </View>
            </View>
            {open === c.id ? <View style={{ paddingBottom: 12 }}><NumberActions name={c.displayName} number={c.number} demo /></View> : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
