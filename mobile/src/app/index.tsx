import { Redirect } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';

/** Splash: shown while the saved session is restored. */
export default function Splash() {
  const { ready, token } = useAuth();
  const t = useTheme();
  if (ready) return <Redirect href={token ? '/home' : '/welcome'} />;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.primary, gap: 8 }}>
      <Text style={{ fontSize: 34, fontWeight: '800', color: t.primaryText }}>RemotePhonebook</Text>
      <Text style={{ color: t.primaryText, opacity: 0.85 }}>Your contacts, from any phone.</Text>
    </View>
  );
}
