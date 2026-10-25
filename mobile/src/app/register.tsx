import { Link, router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { API_URL } from '../lib/config';
import { useTheme } from '../lib/theme';
import { Banner, Body, Button, Field, Screen, Title } from '../components/ui';

function strength(pw: string): { ok: boolean; hint: string } {
  if (pw.length < 10) return { ok: false, hint: 'At least 10 characters, with letters and numbers.' };
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return { ok: false, hint: 'Use both letters and numbers.' };
  return { ok: true, hint: pw.length >= 14 ? 'Strong password.' : 'Good. Longer is stronger.' };
}

export default function Register() {
  const t = useTheme();
  const { register } = useAuth();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pw = strength(password);

  const submit = async () => {
    setError(null);
    if (!fullName.trim()) return setError('Enter your name.');
    if (!email.trim() && !phone.trim()) return setError('Enter a mobile number or an email address.');
    if (!pw.ok) return setError(pw.hint);
    if (password !== confirm) return setError('Passwords do not match.');
    if (!terms) return setError('Please accept the terms and privacy policy.');
    setBusy(true);
    try {
      const res = await register({ fullName: fullName.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined, password });
      router.replace({
        pathname: '/verify',
        params: { identifier: phone.trim() || email.trim(), channels: JSON.stringify(res.channels ?? []) },
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title sub="Register with a mobile number, an email, or both. A verified mobile number lets you use a quick USSD PIN.">Create your account</Title>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field label="Full name" value={fullName} onChangeText={setFullName} autoComplete="name" />
      <Field label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="+254712345678" hint="Include the country code." />
      <Field label="Email (optional if you give a number)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" hint={password ? pw.hint : 'At least 10 characters, with letters and numbers.'} />
      <Field label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: terms }} onPress={() => setTerms(!terms)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 }}>
        <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: t.primary, backgroundColor: terms ? t.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
          {terms ? <Text style={{ color: t.primaryText, fontWeight: '800' }}>✓</Text> : null}
        </View>
        <Body style={{ flex: 1 }}>I accept the <Link href={`${API_URL}/legal/terms`} style={{ color: t.primary }}>terms</Link> and <Link href={`${API_URL}/legal/privacy`} style={{ color: t.primary }}>privacy policy</Link>.</Body>
      </Pressable>
      <Button title="Create account" onPress={submit} loading={busy} />
    </Screen>
  );
}
