import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../lib/auth';
import { SyncProvider } from '../lib/sync/SyncProvider';
import { useTheme } from '../lib/theme';
// Registers the background sync task definition at startup (required by TaskManager).
import '../lib/sync/background';

function Navigator() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.primary,
        headerTitleStyle: { color: t.text },
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: 'Log in' }} />
      <Stack.Screen name="register" options={{ title: 'Create account' }} />
      <Stack.Screen name="verify" options={{ title: 'Verify' }} />
      <Stack.Screen name="forgot" options={{ title: 'Reset password' }} />
      <Stack.Screen name="demo" options={{ title: 'Demo contacts' }} />
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <SyncProvider>
          <StatusBar style="auto" />
          <Navigator />
        </SyncProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
