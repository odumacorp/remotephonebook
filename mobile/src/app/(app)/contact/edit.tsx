import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '../../../lib/api';
import { useSync } from '../../../lib/sync/SyncProvider';
import type { Contact } from '../../../lib/types';
import { Banner, Body, Button, Card, Field, Screen } from '../../../components/ui';

/** Create a manual contact, or edit the name / numbers / labels of an existing one. */
export default function EditContact() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { state, upsertLocal } = useSync();
  const existing = id ? state?.contacts[id] : undefined;
  const [name, setName] = useState(existing?.displayName ?? '');
  const [numbers, setNumbers] = useState(existing?.numbers.map((n) => ({ number: n.number, label: n.label ?? '' })) ?? [{ number: '', label: 'mobile' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    const clean = numbers.filter((n) => n.number.trim()).map((n, i) => ({ number: n.number.trim(), label: n.label.trim() || null, isPrimary: i === 0 }));
    if (!name.trim()) return setError('Enter a name.');
    if (!clean.length) return setError('Add at least one phone number.');
    setBusy(true);
    try {
      const saved = existing
        ? await api<Contact>(`/api/contacts/${existing.id}`, { method: 'PATCH', body: { displayName: name.trim(), numbers: clean, baseVersion: existing.version } })
        : await api<Contact>('/api/contacts', { method: 'POST', body: { displayName: name.trim(), numbers: clean } });
      await upsertLocal(saved);
      router.back();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: existing ? 'Edit contact' : 'New contact' }} />
      {error ? <Banner kind="error">{error}</Banner> : null}
      {existing?.fromThisDevice ? <Banner kind="info">Edits here update your RemotePhonebook copy only, not your phone's address book. If you later change this contact on your phone, the edit made here is kept (server copy wins).</Banner> : null}
      <Field label="Name" value={name} onChangeText={setName} autoComplete="name" />
      {numbers.map((n, i) => (
        <Card key={i}>
          <Field label={i === 0 ? 'Phone (primary)' : `Phone ${i + 1}`} value={n.number} keyboardType="phone-pad" placeholder="+254712345678"
            onChangeText={(v) => setNumbers(numbers.map((x, j) => (j === i ? { ...x, number: v } : x)))} />
          <Field label="Label" value={n.label} placeholder="mobile, work, home…"
            onChangeText={(v) => setNumbers(numbers.map((x, j) => (j === i ? { ...x, label: v } : x)))} />
          {numbers.length > 1 ? <Button compact kind="ghost" title="Remove number" onPress={() => setNumbers(numbers.filter((_, j) => j !== i))} /> : null}
        </Card>
      ))}
      <View>{numbers.length < 10 ? <Button compact kind="secondary" title="+ Add another number" onPress={() => setNumbers([...numbers, { number: '', label: '' }])} /> : null}</View>
      <Body muted>Numbers are stored in international format (e.g. +254…) so they work from any phone.</Body>
      <Button title="Save" onPress={save} loading={busy} />
    </Screen>
  );
}
