import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Banner, Body, Button, Field, Screen, Title } from '../components/ui';

export default function Verify() {
  const { identifier = '', channels, resend } = useLocalSearchParams<{ identifier: string; channels?: string; resend?: string }>();
  const { verify } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sentTo = (() => {
    try {
      return (JSON.parse(channels ?? '[]') as { channel: string; destination: string }[]).map((c) => c.destination).join(' and ');
    } catch {
      return '';
    }
  })();

  const sendAgain = async () => {
    setError(null);
    try {
      await api('/api/auth/verify/resend', { method: 'POST', body: { identifier }, token: null });
      setInfo('If your account needs verification, a new code is on its way.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    if (resend) void sendAgain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) return setError('Enter the 6-digit code.');
    setBusy(true);
    try {
      await verify(identifier, code.trim());
      router.replace('/permission');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub={sentTo ? `We sent a 6-digit code to ${sentTo}.` : 'Enter the 6-digit code we sent you.'}>Verify your account</Title>
      {info ? <Banner kind="ok">{info}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field label="Verification code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" onSubmitEditing={submit} />
      <Button title="Verify" onPress={submit} loading={busy} />
      <Button title="Send a new code" kind="ghost" onPress={sendAgain} />
      {__DEV__ ? <Body muted>Development: codes appear in the server's mock outbox (GET /api/dev/outbox).</Body> : null}
    </Screen>
  );
}
