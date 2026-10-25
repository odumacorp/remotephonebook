import { beforeEach, describe, expect, it } from 'vitest';
import { api, addContacts, bearer, createUser, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('contacts CRUD', () => {
  it('creates, reads, edits and deletes a contact', async () => {
    const u = await createUser();
    const created = await api().post('/api/contacts').set(bearer(u))
      .send({ displayName: 'Alice Wanjiku', numbers: [{ number: '0712 345 678', label: 'mobile' }, { number: '+254 722 000 111', label: 'work' }] })
      .expect(201);
    expect(created.body.numbers[0]).toMatchObject({ normalized: '+254712345678', isPrimary: true, label: 'mobile' });

    const got = await api().get(`/api/contacts/${created.body.id}`).set(bearer(u)).expect(200);
    expect(got.body.displayName).toBe('Alice Wanjiku');

    const patched = await api().patch(`/api/contacts/${created.body.id}`).set(bearer(u))
      .send({ displayName: 'Alice W.', baseVersion: got.body.version }).expect(200);
    expect(patched.body.displayName).toBe('Alice W.');
    expect(patched.body.numbers).toHaveLength(2);
    expect(patched.body.version).toBeGreaterThan(got.body.version);

    // Stale baseVersion is rejected (optimistic concurrency).
    await api().patch(`/api/contacts/${created.body.id}`).set(bearer(u)).send({ displayName: 'X', baseVersion: got.body.version }).expect(409);

    await api().delete(`/api/contacts/${created.body.id}`).set(bearer(u)).expect(204);
    await api().get(`/api/contacts/${created.body.id}`).set(bearer(u)).expect(404);
  });

  it('rejects invalid input', async () => {
    const u = await createUser();
    await api().post('/api/contacts').set(bearer(u)).send({ displayName: '', numbers: [{ number: '0711000111' }] }).expect(400);
    await api().post('/api/contacts').set(bearer(u)).send({ displayName: 'No numbers', numbers: [] }).expect(400);
    await api().post('/api/contacts').set(bearer(u)).send({ displayName: 'Bad', numbers: [{ number: 'call me maybe' }] }).expect(400);
    await api().get('/api/contacts/not-a-uuid').set(bearer(u)).expect(404);
    await api().get('/api/contacts?limit=0').set(bearer(u)).expect(400);
  });
});

describe('listing, pagination and search', () => {
  it('paginates in name order', async () => {
    const u = await createUser();
    await addContacts(u, Array.from({ length: 12 }, (_, i) => ({ displayName: `Person ${String(i).padStart(2, '0')}`, numbers: [{ number: `07110001${String(i).padStart(2, '0')}` }] })));
    const p1 = await api().get('/api/contacts?limit=5&offset=0').set(bearer(u)).expect(200);
    const p3 = await api().get('/api/contacts?limit=5&offset=10').set(bearer(u)).expect(200);
    expect(p1.body.total).toBe(12);
    expect(p1.body.items.map((c: any) => c.displayName)).toEqual(['Person 00', 'Person 01', 'Person 02', 'Person 03', 'Person 04']);
    expect(p1.body.hasMore).toBe(true);
    expect(p3.body.items).toHaveLength(2);
    expect(p3.body.hasMore).toBe(false);
  });

  it('searches by name fragment and number fragment (local or international)', async () => {
    const u = await createUser();
    await addContacts(u, [
      { displayName: 'Brian Otieno', numbers: [{ number: '+254700000102' }] },
      { displayName: 'Esther Achieng', numbers: [{ number: '0733 456 789' }] },
      { displayName: 'Otis Redding', numbers: [{ number: '+14155552671' }] },
    ]);
    const byName = await api().get('/api/contacts/search?q=oti').set(bearer(u)).expect(200);
    // Word-prefix match ("Otis") ranks before mid-word ("Otieno" is also a word prefix here).
    expect(byName.body.items.map((c: any) => c.displayName).sort()).toEqual(['Brian Otieno', 'Otis Redding']);
    const byLocal = await api().get('/api/contacts/search?q=0733456').set(bearer(u)).expect(200);
    expect(byLocal.body.items.map((c: any) => c.displayName)).toEqual(['Esther Achieng']);
    const byIntl = await api().get('/api/contacts/search?q=%2B2547000').set(bearer(u)).expect(200);
    expect(byIntl.body.items.map((c: any) => c.displayName)).toEqual(['Brian Otieno']);
    const accent = await api().get('/api/contacts/search?q=ESTHER').set(bearer(u)).expect(200);
    expect(accent.body.total).toBe(1);
  });

  it('treats search input literally (wildcards, quotes, SQL)', async () => {
    const u = await createUser();
    await addContacts(u, [{ displayName: 'Alpha', numbers: [{ number: '0711000001' }] }]);
    for (const q of ['%', '_', "' OR 1=1 --", '\\']) {
      const res = await api().get(`/api/contacts/search?q=${encodeURIComponent(q)}`).set(bearer(u)).expect(200);
      expect(res.body.total, q).toBe(0);
    }
    await api().get('/api/contacts/search?q=').set(bearer(u)).expect(400);
  });

  it('shows exact duplicates once', async () => {
    const u = await createUser();
    await addContacts(u, [
      { displayName: 'Dup Person', numbers: [{ number: '0711000009' }] },
      { displayName: 'dup  person', numbers: [{ number: '+254711000009' }] },
    ]);
    const list = await api().get('/api/contacts').set(bearer(u)).expect(200);
    expect(list.body.total).toBe(1);
  });
});

describe('cross-account isolation', () => {
  it('never exposes another user\'s contacts', async () => {
    const a = await createUser({ name: 'Alice Owner' });
    const b = await createUser({ name: 'Bob Intruder' });
    const [secretId] = await addContacts(a, [{ displayName: 'Secret Contact', numbers: [{ number: '0711999999' }] }]);

    await api().get(`/api/contacts/${secretId}`).set(bearer(b)).expect(404);
    await api().patch(`/api/contacts/${secretId}`).set(bearer(b)).send({ displayName: 'Hacked' }).expect(404);
    await api().delete(`/api/contacts/${secretId}`).set(bearer(b)).expect(404);
    await api().post(`/api/contacts/${secretId}/accessed`).set(bearer(b)).expect(404);

    const list = await api().get('/api/contacts').set(bearer(b)).expect(200);
    expect(list.body.total).toBe(0);
    const search = await api().get('/api/contacts/search?q=secret').set(bearer(b)).expect(200);
    expect(search.body.total).toBe(0);
    const changes = await api().get('/api/contacts/changes?cursor=0').set(bearer(b)).expect(200);
    expect(changes.body.contacts).toHaveLength(0);

    const still = await api().get(`/api/contacts/${secretId}`).set(bearer(a)).expect(200);
    expect(still.body.displayName).toBe('Secret Contact');
  });
});
