import { router } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';
import { Body, Button, Card, Screen } from '../components/ui';
import { USSD_CODE } from '../lib/config';
import { space, useTheme } from '../lib/theme';

export default function Welcome() {
  const t = useTheme();
  return (
    <Screen>
      <View style={{ paddingTop: 48, gap: space.sm }}>
        <Text accessibilityRole="header" style={{ fontSize: 32, fontWeight: '800', color: t.text }}>RemotePhonebook</Text>
        <Body muted>Back up your contacts to your account, then look them up from any phone by dialling {USSD_CODE} — no app or internet needed on that phone.</Body>
      </View>
      <Card>
        {[
          ['1', 'Create an account and verify your number or email.'],
          ['2', 'Allow contact access and sync your phonebook.'],
          ['3', `Lost your phone? Dial ${USSD_CODE} from any phone and log in.`],
        ].map(([n, text]) => (
          <View key={n} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
            <Text style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: t.primarySoft, color: t.primary, textAlign: 'center', lineHeight: 24, fontWeight: '700' }}>{n}</Text>
            <Body style={{ flex: 1 }}>{text}</Body>
          </View>
        ))}
      </Card>
      <Button title="Create account" onPress={() => router.push('/register')} />
      <Button title="Log in" kind="secondary" onPress={() => router.push('/login')} />
      <Button title="Try with demo contacts" kind="ghost" onPress={() => router.push('/demo')} accessibilityHint="Browse fictional contacts without an account or contact access" />
    </Screen>
  );
}
