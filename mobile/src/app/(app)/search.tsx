import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '../../lib/api';
import type { Contact, Page } from '../../lib/types';
import { Avatar, Banner, Body, Button, Card, Divider, Empty, Field, Row, Screen } from '../../components/ui';

/** Server-side search across the whole account (name or number fragment), paginated. */
export default function Search() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<Contact> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = async (query: string, offset = 0) => {
    if (!query.trim()) return setPage(null);
    setLoading(true);
    setError(null);
    try {
      const res = await api<Page<Contact>>(`/api/contacts/search?q=${encodeURIComponent(query.trim())}&limit=25&offset=${offset}`);
      setPage(offset && page ? { ...res, items: [...page.items, ...res.items] } : res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(q), 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <Screen>
      <Field label="Search all contacts" value={q} onChangeText={setQ} placeholder="Name, or part of a number (e.g. 0712)" autoFocus autoCapitalize="none" />
      {error ? <Banner kind="error">{error}</Banner> : null}
      {page ? <Body muted>{page.total} result{page.total === 1 ? '' : 's'}</Body> : null}
      {page && page.items.length === 0 ? <Empty title={`No contacts match "${q.trim()}"`}>Check the spelling or try fewer letters.</Empty> : null}
      {page && page.items.length ? (
        <Card style={{ paddingVertical: 4 }}>
          {page.items.map((c, i) => (
            <View key={c.id}>
              {i > 0 ? <Divider /> : null}
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Avatar name={c.displayName} demo={c.isDemo} />
                <View style={{ flex: 1 }}>
                  <Row title={c.displayName} subtitle={c.numbers.map((n) => n.formatted).join(' · ')} onPress={() => router.push({ pathname: '/contact/[id]', params: { id: c.id } })} />
                </View>
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      {page?.hasMore ? <Button title="Load more" kind="secondary" loading={loading} onPress={() => run(q, page.items.length)} /> : null}
    </Screen>
  );
}
