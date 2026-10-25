import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DEV_TOOLS, USSD_CODE } from '../../lib/config';
import { Banner, Body, Button, Card, Divider, Field, Pill, Row, Screen, Title } from '../../components/ui';

export default function Account() {
  const { user, logout, refreshUser } = useAuth();
  const [pin, setPin] = useState('');
  const [pinPassword, setPinPassword] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [pendingPhone, setPendingPhone] = useState<{ id: string; phone: string } | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: ok });
      await refreshUser();
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  if (!user) return null;
  return (
    <Screen>
      <Title>{user.fullName}</Title>
      {msg ? <Banner kind={msg.kind}>{msg.text}</Banner> : null}
      <Card>
        <Row title="Phone" subtitle={user.phone ?? 'Not set'} right={user.phone ? <Pill text={user.phoneVerified ? 'Verified' : 'Unverified'} kind={user.phoneVerified ? 'ok' : 'warn'} /> : undefined} />
        <Divider />
        <Row title="Email" subtitle={user.email ?? 'Not set'} right={user.email ? <Pill text={user.emailVerified ? 'Verified' : 'Unverified'} kind={user.emailVerified ? 'ok' : 'warn'} /> : undefined} />
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>USSD PIN</Body>
        <Body muted>
          When you dial {USSD_CODE} from your own verified phone you can log in with a 4–6 digit PIN instead of typing your password, which USSD shows on screen.
          From any other phone you will still need your password.
        </Body>
        <Pill text={user.ussdPinSet ? 'PIN is set' : 'No PIN'} kind={user.ussdPinSet ? 'ok' : 'warn'} />
        <Field label="New PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Field label="Current password" value={pinPassword} onChangeText={setPinPassword} secureTextEntry />
        <Button compact title={user.ussdPinSet ? 'Change PIN' : 'Set PIN'} loading={busy === 'pin'}
          onPress={() => act('pin', async () => { await api('/api/account/ussd-pin', { method: 'PUT', body: { password: pinPassword, pin } }); setPin(''); setPinPassword(''); }, 'USSD PIN saved.')} />
        {user.ussdPinSet ? (
          <Button compact kind="ghost" title="Remove PIN" loading={busy === 'pinclear'}
            onPress={() => act('pinclear', () => api('/api/account/ussd-pin', { method: 'PUT', body: { password: pinPassword, pin: null } }), 'PIN removed.')} />
        ) : null}
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>Linked phone numbers</Body>
        <Body muted>Add another SIM you own. Once verified, it can also use your USSD PIN.</Body>
        {user.linkedPhones?.map((p) => (
          <Row key={p.id} title={p.phone} subtitle={p.verifiedAt ? 'Verified' : 'Waiting for verification'}
            right={<Button compact kind="ghost" title="Remove" onPress={() => act(`rm${p.id}`, () => api(`/api/account/phones/${p.id}`, { method: 'DELETE' }), 'Number removed.')} />} />
        ))}
        {pendingPhone ? (
          <View style={{ gap: 8 }}>
            <Field label={`Code sent to ${pendingPhone.phone}`} value={phoneCode} onChangeText={setPhoneCode} keyboardType="number-pad" maxLength={6} />
            <Button compact title="Verify number" loading={busy === 'verifyphone'}
              onPress={() => act('verifyphone', async () => { await api(`/api/account/phones/${pendingPhone.id}/verify`, { method: 'POST', body: { code: phoneCode } }); setPendingPhone(null); setPhoneCode(''); }, 'Number verified.')} />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Field label="Add a number" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" placeholder="+254…" />
            <Button compact kind="secondary" title="Send verification code" loading={busy === 'addphone'}
              onPress={() => act('addphone', async () => { const r = await api<{ id: string; phone: string }>('/api/account/phones', { method: 'POST', body: { phone: newPhone } }); setPendingPhone(r); setNewPhone(''); }, 'Code sent.')} />
          </View>
        )}
      </Card>

      <Card style={{ paddingVertical: 4 }}>
        <Row title="Sync status" onPress={() => router.push('/sync-status')} />
        <Divider />
        <Row title="Devices" subtitle="Phones signed in to your account" onPress={() => router.push('/devices')} />
        <Divider />
        <Row title="Privacy & security" subtitle="Consent, USSD access, export, delete" onPress={() => router.push('/privacy')} />
        {DEV_TOOLS ? (<><Divider /><Row title="USSD simulator (dev)" onPress={() => router.push('/ussd-simulator')} /></>) : null}
      </Card>
      <Button title="Log out" kind="secondary" onPress={async () => { await logout(); router.replace('/welcome'); }} />
    </Screen>
  );
}
