import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { api, bearer, createUser, device, resetDb } from './helpers.js';

beforeEach(resetDb);

const phonebook = (n: number, prefix = 'Contact') =>
  Array.from({ length: n }, (_, i) => ({
    sourceContactId: `native-${i}`,
    displayName: `${prefix} ${String(i).padStart(2, '0')}`,
    numbers: [{ number: `07120000${String(i).padStart(2, '0')}`, label: 'mobile' }],
  }));

describe('contact sync', () => {
  it('requires consent before uploading contacts', async () => {
    const u = await createUser({ consent: false });
    const res = await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(1) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.consentRequired).toBe(true);
  });

  it('does an initial sync, then incremental updates and deletions', async () => {
    const u = await createUser();
    const first = await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(3) }).expect(200);
    expect(first.body.summary.created).toBe(3);
    expect(first.body.syncedAt).toBeTruthy();

    // Re-sending identical data changes nothing.
    const again = await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(3) }).expect(200);
    expect(again.body.summary.unchanged).toBe(3);

    const versions = Object.fromEntries(first.body.results.map((r: any) => [r.sourceContactId, r.version]));
    const changed = await api().post('/api/contacts/sync').set(bearer(u)).send({
      upserts: [{ ...phonebook(1)[0], displayName: 'Renamed', baseVersion: versions['native-0'] }],
      deletes: [{ sourceContactId: 'native-2', baseVersion: versions['native-2'] }],
    }).expect(200);
    expect(changed.body.summary).toMatchObject({ updated: 1, deleted: 1 });

    const list = await api().get('/api/contacts').set(bearer(u)).expect(200);
    expect(list.body.items.map((c: any) => c.displayName)).toEqual(['Contact 01', 'Renamed']);

    // Tombstone remains so other devices learn about the deletion.
    const tomb = await query('SELECT deleted_at FROM contacts WHERE user_id = $1 AND deleted_at IS NOT NULL', [u.id]);
    expect(tomb).toHaveLength(1);
  });

  it('pulls changes incrementally with a cursor, including deletions, across devices', async () => {
    const u = await createUser();
    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(4) }).expect(200);

    // Second device logs in and pulls everything in pages.
    const tablet = await api().post('/api/auth/login').send({ identifier: u.email, password: u.password, device: device('tablet') });
    const t = { token: tablet.body.token };
    const page1 = await api().get('/api/contacts/changes?cursor=0&limit=3').set(bearer(t)).expect(200);
    expect(page1.body.contacts).toHaveLength(3);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.contacts[0].fromThisDevice).toBe(false);
    const page2 = await api().get(`/api/contacts/changes?cursor=${page1.body.cursor}&limit=3`).set(bearer(t)).expect(200);
    expect(page2.body.contacts).toHaveLength(1);
    expect(page2.body.hasMore).toBe(false);

    // Phone deletes one; tablet sees only that change.
    await api().post('/api/contacts/sync').set(bearer(u)).send({ deletes: ['native-1'] }).expect(200);
    const delta = await api().get(`/api/contacts/changes?cursor=${page2.body.cursor}`).set(bearer(t)).expect(200);
    expect(delta.body.contacts).toHaveLength(1);
    expect(delta.body.contacts[0].deletedAt).toBeTruthy();

    // The phone sees its own source ids so it can map them back.
    const own = await api().get('/api/contacts/changes?cursor=0').set(bearer(u)).expect(200);
    expect(own.body.contacts.every((c: any) => c.fromThisDevice && c.sourceContactId?.startsWith('native-'))).toBe(true);
  });

  it('resolves conflicts in favour of the server copy', async () => {
    const u = await createUser();
    const first = await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(1) }).expect(200);
    const { contactId, version } = first.body.results[0];

    // Edited in the app (e.g. on another device) after the phone last synced.
    await api().patch(`/api/contacts/${contactId}`).set(bearer(u)).send({ displayName: 'Edited In App' }).expect(200);

    const stale = await api().post('/api/contacts/sync').set(bearer(u))
      .send({ upserts: [{ ...phonebook(1)[0], displayName: 'Edited On Phone', baseVersion: version }] }).expect(200);
    expect(stale.body.results[0].status).toBe('conflict');
    expect(stale.body.results[0].server.displayName).toBe('Edited In App');

    const del = await api().post('/api/contacts/sync').set(bearer(u))
      .send({ deletes: [{ sourceContactId: 'native-0', baseVersion: version }] }).expect(200);
    expect(del.body.results[0].status).toBe('conflict');

    const got = await api().get(`/api/contacts/${contactId}`).set(bearer(u)).expect(200);
    expect(got.body.displayName).toBe('Edited In App');
  });

  it('keeps contacts on the server when the deletion policy is "keep"', async () => {
    const u = await createUser();
    await api().patch('/api/account').set(bearer(u)).send({ deletionPolicy: 'keep' }).expect(200);
    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(2) }).expect(200);
    const res = await api().post('/api/contacts/sync').set(bearer(u)).send({ deletes: ['native-0'] }).expect(200);
    expect(res.body.results[0].status).toBe('kept');
    const list = await api().get('/api/contacts').set(bearer(u)).expect(200);
    expect(list.body.total).toBe(2);
  });

  it('guards against accidental mass deletion', async () => {
    const u = await createUser();
    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(30) }).expect(200);
    const deletes = phonebook(30).map((c) => c.sourceContactId);
    await api().post('/api/contacts/sync').set(bearer(u)).send({ deletes }).expect(409);
    await api().post('/api/contacts/sync').set(bearer(u)).send({ deletes, confirmMassDelete: true }).expect(200);
  });

  it('validates batches and reports invalid entries without failing the batch', async () => {
    const u = await createUser();
    const res = await api().post('/api/contacts/sync').set(bearer(u)).send({
      upserts: [
        { sourceContactId: 'ok', displayName: 'Valid', numbers: [{ number: '0711000123' }] },
        { sourceContactId: 'nonum', displayName: 'No Number', numbers: [] },
        { sourceContactId: 'bad', displayName: 'Bad', numbers: [{ number: 'abc' }] },
      ],
    }).expect(200);
    expect(res.body.summary).toMatchObject({ created: 1, invalid: 2 });
    // Batch-size limit (100 in the test config).
    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(101) }).expect(400);
  });

  it('reports sync status accurately', async () => {
    const u = await createUser();
    let status = await api().get('/api/contacts/sync/status').set(bearer(u)).expect(200);
    expect(status.body).toMatchObject({ status: 'never', lastSuccessfulSyncAt: null, totalContacts: 0 });

    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(2) }).expect(200);
    status = await api().get('/api/contacts/sync/status').set(bearer(u)).expect(200);
    expect(status.body.status).toBe('success');
    expect(status.body.totalContacts).toBe(2);
    expect(status.body.lastSuccessfulSyncAt).toBeTruthy();
    const lastOk = status.body.lastSuccessfulSyncAt;

    // A failed sync does not move the last-successful timestamp.
    await api().post('/api/contacts/sync/report').set(bearer(u)).send({ status: 'error', error: 'Contacts permission revoked' }).expect(204);
    status = await api().get('/api/contacts/sync/status').set(bearer(u)).expect(200);
    expect(status.body.status).toBe('error');
    expect(status.body.lastError).toBe('Contacts permission revoked');
    expect(status.body.lastSuccessfulSyncAt).toBe(lastOk);

    // Partial (non-final) chunk leaves status in progress.
    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(1), final: false }).expect(200);
    status = await api().get('/api/contacts/sync/status').set(bearer(u)).expect(200);
    expect(status.body.status).toBe('in_progress');
  });

  it('asks for a full resync when the cursor predates purged tombstones', async () => {
    const u = await createUser();
    await api().post('/api/contacts/sync').set(bearer(u)).send({ upserts: phonebook(2) }).expect(200);
    await query("UPDATE system_meta SET value = '999999999' WHERE key = 'tombstones_purged_through_version'");
    const res = await api().get('/api/contacts/changes?cursor=1').set(bearer(u)).expect(200);
    expect(res.body.reset).toBe(true);
    expect(res.body.contacts).toHaveLength(2);
  });

  it('requires a device-bound session', async () => {
    const u = await createUser();
    const noDevice = await api().post('/api/auth/login').send({ identifier: u.email, password: u.password });
    await api().post('/api/contacts/sync').set('Authorization', `Bearer ${noDevice.body.token}`).send({ upserts: phonebook(1) }).expect(400);
  });
});
