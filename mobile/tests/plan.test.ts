import { describe, expect, it } from 'vitest';
import { chunk, contactHash, planSync, type DeviceContact, type ServerCopy, type SyncedEntry } from '../src/lib/sync/plan';

const dc = (id: string, name: string, number = `07110000${id.padStart(2, '0')}`): DeviceContact => ({ nativeId: id, displayName: name, numbers: [{ number, label: 'mobile' }] });
const entry = (c: DeviceContact, version: number): SyncedEntry => ({ hash: contactHash(c), version, contactId: `srv-${c.nativeId}` });
const server = (c: DeviceContact, version: number, deleted = false): [string, ServerCopy] => [c.nativeId, { version, contactId: `srv-${c.nativeId}`, deleted, hash: contactHash(c) }];

describe('planSync', () => {
  it('uploads everything on the first sync', () => {
    const plan = planSync([dc('1', 'A'), dc('2', 'B')], {}, new Map());
    expect(plan.upserts.map((u) => u.sourceContactId)).toEqual(['1', '2']);
    expect(plan.upserts[0].baseVersion).toBeNull();
    expect(plan.deletes).toEqual([]);
  });

  it('only uploads contacts changed since the last sync (incremental)', () => {
    const a = dc('1', 'A'), b = dc('2', 'B');
    const synced = { '1': entry(a, 5), '2': entry(b, 6) };
    const plan = planSync([a, { ...b, displayName: 'B renamed' }], synced, new Map([server(a, 5), server(b, 6)]));
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({ sourceContactId: '2', displayName: 'B renamed', baseVersion: 6 });
  });

  it('sends the last agreed version, so server-side edits are detected as conflicts', () => {
    const a = dc('1', 'A');
    // Edited in the app: server is now at v9, device last agreed on v5.
    const plan = planSync([{ ...a, displayName: 'A (phone edit)' }], { '1': entry(a, 5) }, new Map([[a.nativeId, { version: 9, contactId: 'srv-1', deleted: false, hash: 'other' }]]));
    expect(plan.upserts[0].baseVersion).toBe(5);
  });

  it('does not overwrite app edits when the phonebook entry is unchanged', () => {
    const a = dc('1', 'A');
    const plan = planSync([a], { '1': entry(a, 5) }, new Map([[a.nativeId, { version: 9, contactId: 'srv-1', deleted: false, hash: 'edited-in-app' }]]));
    expect(plan.upserts).toHaveLength(0);
  });

  it('adopts identical server copies after a reinstall instead of re-uploading', () => {
    const a = dc('1', 'A');
    const plan = planSync([a], {}, new Map([server(a, 7)]));
    expect(plan.upserts).toHaveLength(0);
    expect(plan.adopt['1']).toMatchObject({ version: 7 });
  });

  it('deletes contacts removed from the phonebook', () => {
    const a = dc('1', 'A'), b = dc('2', 'B');
    const plan = planSync([a], { '1': entry(a, 1), '2': entry(b, 2) }, new Map([server(a, 1), server(b, 2)]));
    expect(plan.deletes).toEqual([{ sourceContactId: '2', baseVersion: 2 }]);
  });

  it('forgets contacts already deleted on the server', () => {
    const a = dc('1', 'A'), b = dc('2', 'B');
    const plan = planSync([a], { '1': entry(a, 1), '2': entry(b, 2) }, new Map([server(a, 1), server(b, 3, true)]));
    expect(plan.deletes).toEqual([]);
    expect(plan.forget).toEqual(['2']);
  });

  it('never deletes on an empty phonebook read', () => {
    const a = dc('1', 'A');
    const plan = planSync([], { '1': entry(a, 1) }, new Map([server(a, 1)]));
    expect(plan.suspiciousEmptyRead).toBe(true);
    expect(plan.deletes).toEqual([]);
  });

  it('skips entries without phone numbers', () => {
    const plan = planSync([{ nativeId: 'x', displayName: 'No number', numbers: [] }], {}, new Map());
    expect(plan.upserts).toHaveLength(0);
    expect(plan.skippedNoNumber).toBe(1);
  });

  it('marks the first number as primary', () => {
    const plan = planSync([{ nativeId: '1', displayName: 'Multi', numbers: [{ number: '0711000001' }, { number: '0711000002', label: 'work' }] }], {}, new Map());
    expect(plan.upserts[0].numbers.map((n) => n.isPrimary)).toEqual([true, false]);
  });
});

describe('helpers', () => {
  it('hashes content deterministically', () => {
    expect(contactHash(dc('1', 'A'))).toBe(contactHash(dc('9', 'A', '0711000001')));
    expect(contactHash(dc('1', 'A'))).not.toBe(contactHash(dc('1', 'B')));
  });
  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
