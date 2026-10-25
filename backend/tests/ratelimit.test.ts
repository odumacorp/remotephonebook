import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { hitLimit } from '../src/services/rateLimit.js';
import { api, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('rate limiting', () => {
  it('counts hits in a fixed window and resets after it', async () => {
    for (let i = 1; i <= 3; i++) expect((await hitLimit('k', 3, 60)).allowed).toBe(true);
    const blocked = await hitLimit('k', 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    await query("UPDATE rate_limits SET window_start = now() - interval '2 minutes'");
    expect((await hitLimit('k', 3, 60)).allowed).toBe(true);
  });

  it('stores only hashed bucket keys', async () => {
    await hitLimit('login:id:someone@example.test', 3, 60);
    const rows = await query('SELECT bucket_key FROM rate_limits');
    expect(rows[0].bucket_key).not.toContain('someone');
  });

  it('returns 429 with Retry-After on the login endpoint', async () => {
    let last;
    for (let i = 0; i < 21; i++) {
      last = await api().post('/api/auth/login').send({ identifier: 'flood@example.test', password: 'Whatever-123' });
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    expect(last!.body.error.code).toBe('rate_limited');
  });

  it('limits registration and recovery', async () => {
    let status = 0;
    for (let i = 0; i < 6; i++) {
      status = (await api().post('/api/auth/recovery').send({ identifier: 'flood@example.test' })).status;
    }
    expect(status).toBe(429);
  });

  it('limits USSD request floods per phone with an END screen', async () => {
    for (let i = 0; i < 120; i++) await hitLimit('ussd_req:+254799000009', 120, 300);
    const res = await api().post('/api/ussd').type('form')
      .send({ sessionId: 'flood', serviceCode: '*123#', phoneNumber: '+254799000009', text: '' });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^END Too many requests/);
  });
});
