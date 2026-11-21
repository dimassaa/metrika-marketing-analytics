import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /health', () => {
  it('returns 200 with a healthy db', async () => {
    const app = createApp({ db: { query: async () => ({ rows: [{ ok: 1 }] }) } });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns 503 when db is down', async () => {
    const app = createApp({ db: { query: async () => { throw new Error('boom'); } } });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
  });
});
