import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Platform, Share, Switch, View } from 'react-native';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { API_URL, USSD_CODE } from '../../lib/config';
import { disableBackgroundSync } from '../../lib/sync/background';
import { Banner, Body, Button, Card, Divider, Field, Row, Screen, Title } from '../../components/ui';

export default function Privacy() {
  const { user, updateAccount, clearSession } = useAuth();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [deletePw, setDeletePw] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  if (!user) return null;

  const toggle = async (patch: Parameters<typeof updateAccount>[0], ok: string) => {
    setMsg(null);
    try {
      await updateAccount(patch);
      setMsg({ kind: 'ok', text: ok });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    }
  };

  const exportData = async () => {
    setBusy('export');
    try {
      const data = await api('/api/account/export');
      const json = JSON.stringify(data, null, 2);
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'remotephonebook-export.json';
        a.click();
      } else {
        await Share.share({ message: json, title: 'RemotePhonebook export' });
      }
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    setBusy('delete');
    try {
      await api('/api/account', { method: 'DELETE', body: { password: deletePw, confirm: 'DELETE' } });
      await disableBackgroundSync();
      await clearSession();
      router.replace('/welcome');
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Title>Privacy & security</Title>
      {msg ? <Banner kind={msg.kind}>{msg.text}</Banner> : null}
      <Card>
        <Row title="Store my contacts in the cloud" subtitle="Required for sync and USSD lookup. Turning it off stops uploads; existing contacts stay until you delete them."
          right={<Switch value={Boolean(user.contactsConsentAt)} onValueChange={(v) => toggle({ contactsConsent: v }, v ? 'Uploads enabled.' : 'Uploads stopped.')} />} />
        <Divider />
        <Row title={`USSD access (${USSD_CODE})`} subtitle="Allow logging in to your contacts from any phone."
          right={<Switch value={user.ussdEnabled} onValueChange={(v) => toggle({ ussdEnabled: v }, v ? 'USSD access on.' : 'USSD access off.')} />} />
        <Divider />
        <Row title="Delete from cloud when deleted on phone" subtitle={user.deletionPolicy === 'mirror' ? 'On: deletions on this phone also remove the cloud copy.' : 'Off: the cloud keeps contacts you delete on your phone.'}
          right={<Switch value={user.deletionPolicy === 'mirror'} onValueChange={(v) => toggle({ deletionPolicy: v ? 'mirror' : 'keep' }, 'Deletion setting saved.')} />} />
      </Card>
      <Card>
        <Body style={{ fontWeight: '700' }}>How your data is protected</Body>
        <Body muted>• Passwords and PINs are stored only as one-way hashes (Argon2id).{'\n'}• All traffic uses HTTPS in production.{'\n'}• Your session token is kept in the phone's secure keychain.{'\n'}• Only you can see your contacts, after logging in.{'\n'}• USSD shows what you type, including passwords. Prefer a USSD PIN from your own phone, and log out when done.</Body>
      </Card>
      <Card style={{ paddingVertical: 4 }}>
        <Row title="Privacy policy" onPress={() => Linking.openURL(`${API_URL}/legal/privacy`)} />
        <Divider />
        <Row title="Terms of service" onPress={() => Linking.openURL(`${API_URL}/legal/terms`)} />
      </Card>
      <Button title="Export my data (JSON)" kind="secondary" loading={busy === 'export'} onPress={exportData} />
      <Card>
        <Body style={{ fontWeight: '700' }}>Delete account</Body>
        <Body muted>Permanently deletes your account, all synced contacts and devices. Your phone's own address book is not touched. This cannot be undone.</Body>
        <View style={{ gap: 8 }}>
          <Field label="Password" value={deletePw} onChangeText={setDeletePw} secureTextEntry />
          <Button title="Delete my account" kind="danger" disabled={!deletePw} loading={busy === 'delete'} onPress={deleteAccount} />
        </View>
      </Card>
    </Screen>
  );
}
