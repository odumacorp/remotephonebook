import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '../../lib/api';
import { formatWhen } from '../../lib/format';
import type { Device } from '../../lib/types';
import { Banner, Body, Button, Card, Divider, Pill, Row, Screen, Title } from '../../components/ui';

export default function Devices() {
  const [items, setItems] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: Device[] }>('/api/devices').then((r) => setItems(r.items)).catch((e) => setError(errorMessage(e)));
  }, []);
  useFocusEffect(load);

  const remove = async (id: string) => {
    try {
      await api(`/api/devices/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Screen>
      <Title sub="Removing a device signs it out and stops it syncing. Contacts it uploaded stay in your account, so you can still reach them over USSD after losing a phone.">Devices</Title>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Card style={{ paddingVertical: 4 }}>
        {items?.length === 0 ? <Body muted>No devices.</Body> : null}
        {items?.map((d, i) => (
          <View key={d.id}>
            {i > 0 ? <Divider /> : null}
            <Row
              title={d.name ?? d.platform}
              subtitle={`${d.platform} · seen ${formatWhen(d.lastSeenAt)} · synced ${formatWhen(d.lastSyncAt)}`}
              right={d.current ? <Pill text="This device" kind="ok" /> : <Button compact kind="ghost" title="Remove" onPress={() => remove(d.id)} />}
            />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
