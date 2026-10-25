import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import React, { useState } from 'react';
import { Alert, Platform, Share, View } from 'react-native';
import { Button } from './ui';

/**
 * Copy / call / SMS / share for one number. Calls and messages open the system dialer or
 * messaging app with the number filled in; nothing is placed or sent without the user acting there.
 */
export function NumberActions({ name, number, demo }: { name: string; number: string; demo?: boolean }) {
  const [copied, setCopied] = useState(false);

  const notifyDemo = (action: string, go: () => void) => {
    if (!demo) return go();
    const msg = 'This is a fictional demo number and is not reachable.';
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (window.confirm(`${msg} ${action} anyway?`)) go();
      return;
    }
    Alert.alert('Demo contact', msg, [{ text: 'Cancel', style: 'cancel' }, { text: `${action} anyway`, onPress: go }]);
  };

  const open = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Not available', 'This device cannot open that app.');
    }
  };

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Button
        compact kind="secondary" title={copied ? 'Copied ✓' : 'Copy'}
        accessibilityHint={`Copies ${number} to the clipboard`}
        onPress={async () => {
          await Clipboard.setStringAsync(number);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      />
      <Button compact kind="secondary" title="Call" accessibilityHint="Opens the phone dialer" onPress={() => notifyDemo('Call', () => open(`tel:${number}`))} />
      <Button compact kind="secondary" title="SMS" accessibilityHint="Opens your messaging app" onPress={() => notifyDemo('Message', () => open(`sms:${number}`))} />
      <Button compact kind="ghost" title="Share" onPress={() => Share.share({ message: `${name}: ${number}` }).catch(() => {})} />
    </View>
  );
}
