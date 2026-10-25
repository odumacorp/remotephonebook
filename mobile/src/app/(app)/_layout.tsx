import { Redirect, Stack } from 'expo-router';
import React from 'react';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { Loading } from '../../components/ui';

export default function AppLayout() {
  const { ready, token } = useAuth();
  const t = useTheme();
  if (!ready) return <Loading />;
  if (!token) return <Redirect href="/welcome" />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.card }, headerTintColor: t.primary, headerTitleStyle: { color: t.text }, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="home" options={{ title: 'RemotePhonebook' }} />
      <Stack.Screen name="permission" options={{ title: 'Contact access' }} />
      <Stack.Screen name="initial-sync" options={{ title: 'Syncing', headerBackVisible: false, gestureEnabled: false }} />
      <Stack.Screen name="contact/[id]" options={{ title: 'Contact' }} />
      <Stack.Screen name="contact/edit" options={{ title: 'Edit contact' }} />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
      <Stack.Screen name="sync-status" options={{ title: 'Sync status' }} />
      <Stack.Screen name="account" options={{ title: 'Account' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy & security' }} />
      <Stack.Screen name="ussd-simulator" options={{ title: 'USSD simulator' }} />
    </Stack>
  );
}
