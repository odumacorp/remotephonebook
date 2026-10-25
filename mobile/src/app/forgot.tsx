import { router } from 'expo-router';
import React, { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Banner, Button, Field, Screen, Title } from '../components/ui';

export default function Forgot() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setError(null);
    if (!identifier.trim()) return setError('Enter your phone number or email.');
    setBusy(true);
    try {
      await api('/api/auth/recovery', { method: 'POST', body: { identifier: identifier.trim() }, token: null });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await api('/api/auth/recovery/confirm', { method: 'POST', body: { identifier: identifier.trim(), code: code.trim(), newPassword: password }, token: null });
      router.replace('/login');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub="We'll send a one-time code to your verified phone or email. Resetting signs you out everywhere.">Reset your password</Title>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field label="Phone number or email" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" editable={!sent} />
      {!sent ? (
        <Button title="Send code" onPress={request} loading={busy} />
      ) : (
        <>
          <Banner kind="ok">If an account matches, a code is on its way.</Banner>
          <Field label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
          <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint="At least 10 characters, with letters and numbers." />
          <Button title="Set new password" onPress={confirm} loading={busy} />
        </>
      )}
    </Screen>
  );
}
