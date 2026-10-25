import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { USSD_CODE } from '../../lib/config';
import { useSync } from '../../lib/sync/SyncProvider';
import { Banner, Body, Button, Card, Screen, Title } from '../../components/ui';

/**
 * Explains why contact access is needed *before* the OS prompt, and records the user's consent to
 * store contacts in the cloud. Declining is always possible.
 */
export default function Permission() {
  const { user, updateAccount } = useAuth();
  const { access, requestAccess } = useSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!user?.contactsConsentAt) await updateAccount({ contactsConsent: true });
      const result = access === 'granted' ? 'granted' : await requestAccess();
      if (result === 'granted') router.replace('/initial-sync');
      else setError(result === 'denied' ? 'Contact access is turned off. You can enable it in Settings.' : 'Contact access was not granted.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub="Before we ask your phone for permission, here is exactly what happens.">Sync your contacts</Title>
      <Card>
        {[
          ['What we read', 'Names and phone numbers only. Not emails, photos, notes or addresses.'],
          ['Where it goes', 'Your RemotePhonebook account, over an encrypted connection.'],
          ['Who can see it', `Only you, after logging in to the app or dialling ${USSD_CODE} and logging in. Anyone who knows your login can see these contacts over USSD, so keep it private.`],
          ['Your control', 'Turn sync off, export or delete your data at any time in Privacy & security.'],
        ].map(([h, b]) => (
          <View key={h} style={{ gap: 2, paddingVertical: 4 }}>
            <Body style={{ fontWeight: '700' }}>{h}</Body>
            <Body muted>{b}</Body>
          </View>
        ))}
      </Card>
      {Platform.OS === 'web' ? (
        <Banner kind="warn">Phonebook access is not available in the web build. Use the Android or iOS app, or add contacts manually.</Banner>
      ) : null}
      {error ? (
        <Banner kind="error" action={access === 'denied' ? <Button compact kind="secondary" title="Open Settings" onPress={() => Linking.openSettings()} /> : undefined}>{error}</Banner>
      ) : null}
      {Platform.OS !== 'web' ? <Button title="Allow and sync contacts" onPress={allow} loading={busy} /> : null}
      <Button title="Not now — use demo contacts" kind="secondary" onPress={() => router.replace('/demo')} />
      <Button title="Skip and add contacts manually" kind="ghost" onPress={() => router.replace('/home')} />
    </Screen>
  );
}
