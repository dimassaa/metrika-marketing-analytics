import { describe, it, expect } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../../src/app.js';

// A MemoryStore keeps the fake database truly fake: the PostgreSQL session store would need a real pool, and these
// tests only exercise the health probe.
describe('GET /health', () => {
  it('returns 200 with a healthy db', async () => {
    const app = createApp({
      db: { query: async () => ({ rows: [{ ok: 1 }] }) },
      sessionStore: new session.MemoryStore(),
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns 503 when db is down', async () => {
    const app = createApp({
      db: { query: async () => { throw new Error('boom'); } },
      sessionStore: new session.MemoryStore(),
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
  });
});
