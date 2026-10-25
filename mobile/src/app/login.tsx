import { Link, router } from 'expo-router';
import React, { useState } from 'react';
import { ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Banner, Body, Button, Field, Screen, Title } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!identifier.trim() || !password) return setError('Enter your phone number or email and your password.');
    setBusy(true);
    try {
      await login(identifier.trim(), password);
      router.replace('/home');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'verification_required') {
        router.push({ pathname: '/verify', params: { identifier: identifier.trim(), resend: '1' } });
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub="Use the phone number or email you registered with.">Welcome back</Title>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field label="Phone number or email" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoComplete="username" keyboardType="email-address" placeholder="+254712345678 or you@example.com" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" onSubmitEditing={submit} />
      <Button title="Log in" onPress={submit} loading={busy} />
      <Link href="/forgot" style={{ alignSelf: 'center', padding: 8 }}><Body muted>Forgot password?</Body></Link>
    </Screen>
  );
}
