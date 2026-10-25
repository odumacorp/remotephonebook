import * as Crypto from 'expo-crypto';
import React, { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { API_URL, DEV_TOOLS, USSD_CODE } from '../../lib/config';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { Banner, Body, Button, Card, Field, Screen } from '../../components/ui';

/**
 * Development-only: dials the backend's USSD handler (via /api/dev/ussd) exactly as
 * Africa's Talking would, so the whole menu can be tested without a telecom connection.
 */
export default function UssdSimulator() {
  const t = useTheme();
  const { user } = useAuth();
  const [phone, setPhone] = useState(user?.phone ?? '+254700000999');
  const [screen, setScreen] = useState<{ kind: string; text: string } | null>(null);
  const [input, setInput] = useState('');
  const session = useRef<{ id: string; inputs: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!DEV_TOOLS) return <Screen><Banner kind="warn">The USSD simulator is only available in development builds.</Banner></Screen>;

  const post = async () => {
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/dev/ussd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.current!.id, phoneNumber: phone.trim(), text: session.current!.inputs.join('*') }),
      });
      if (res.status === 404) throw new Error('Dev tools are disabled on the server.');
      const text = await res.text();
      setScreen({ kind: text.slice(0, 3), text: text.slice(4) });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const dial = () => {
    session.current = { id: `APP-${Crypto.randomUUID()}`, inputs: [] };
    void post();
  };
  const send = () => {
    if (!session.current || screen?.kind !== 'CON') return;
    session.current.inputs.push(input);
    setInput('');
    void post();
  };

  return (
    <Screen>
      <Body muted>Simulates dialling {USSD_CODE}. Real USSD shows typed passwords on screen — this simulator does the same.</Body>
      <Field label="Caller phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Card style={{ backgroundColor: '#1D2430', padding: 14 }}>
        <View style={{ backgroundColor: '#D9E4D1', borderRadius: 8, padding: 12, minHeight: 220 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#3C5A35', marginBottom: 6 }}>
            {screen ? (screen.kind === 'END' ? 'SESSION ENDED' : 'AWAITING INPUT') : 'READY'}
          </Text>
          <Text style={{ fontFamily: 'monospace', fontSize: 15, color: '#14210F', lineHeight: 21 }}>{screen?.text ?? `Tap "Dial ${USSD_CODE}" to start.`}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <TextInput
            accessibilityLabel="USSD reply"
            value={input} onChangeText={setInput} onSubmitEditing={send} editable={screen?.kind === 'CON'}
            placeholder="Reply" placeholderTextColor="#889"
            style={{ flex: 1, backgroundColor: '#0B0F14', color: '#fff', borderRadius: 8, paddingHorizontal: 10, minHeight: 44, fontSize: 16 }}
          />
          <Button compact title="Send" onPress={send} disabled={screen?.kind !== 'CON'} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Button compact title={`Dial ${USSD_CODE}`} onPress={dial} />
          <Button compact kind="secondary" title="Hang up" onPress={() => { session.current = null; setScreen({ kind: 'END', text: 'Call ended.' }); }} />
        </View>
      </Card>
      <Text style={{ color: t.muted, fontSize: 13 }}>Seeded test user: +254700000999 · password TestPass2026! · PIN 2468 (dial from +254700000999 to get the PIN prompt).</Text>
    </Screen>
  );
}
