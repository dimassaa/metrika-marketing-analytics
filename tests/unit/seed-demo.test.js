import { describe, expect, it, vi } from 'vitest';
import { seedDemoIfEmpty } from '../../scripts/seed-demo.js';

/**
 * Builds a pool stub that answers the three-table guard query. The guard itself must always run: seeding only when
 * every table is empty is what keeps imported production-like data from being truncated on the next container start.
 * @param {{ users?: number, channels?: number, dailyStats?: number }} counts
 */
function poolWith({ users = 0, channels = 0, dailyStats = 0 } = {}) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ users, channels, daily_stats: dailyStats }] }),
  };
}

describe('seedDemoIfEmpty', () => {
  it('seeds once when users, channels and daily_stats are all empty', async () => {
    const pool = poolWith();
    const seedFn = vi.fn().mockResolvedValue({ users: 3 });

    const result = await seedDemoIfEmpty({ pool, seedFn });

    expect(seedFn).toHaveBeenCalledTimes(1);
    expect(seedFn).toHaveBeenCalledWith({ pool });
    expect(result).toEqual({ seeded: true, counts: { users: 0, channels: 0, daily_stats: 0 } });
  });

  it('does not seed when channels already have rows even though users is empty', async () => {
    const pool = poolWith({ channels: 8 });
    const seedFn = vi.fn();

    const result = await seedDemoIfEmpty({ pool, seedFn });

    expect(seedFn).not.toHaveBeenCalled();
    expect(result).toEqual({ seeded: false, counts: { users: 0, channels: 8, daily_stats: 0 } });
  });

  it('does not seed when daily_stats already has rows even though users is empty', async () => {
    const pool = poolWith({ dailyStats: 12_691 });
    const seedFn = vi.fn();

    const result = await seedDemoIfEmpty({ pool, seedFn });

    expect(seedFn).not.toHaveBeenCalled();
    expect(result).toEqual({ seeded: false, counts: { users: 0, channels: 0, daily_stats: 12_691 } });
  });

  it('does not seed when any single table is populated', async () => {
    for (const counts of [{ users: 1 }, { channels: 1 }, { dailyStats: 1 }]) {
      const pool = poolWith(counts);
      const seedFn = vi.fn();
      await seedDemoIfEmpty({ pool, seedFn });
      expect(seedFn, JSON.stringify(counts)).not.toHaveBeenCalled();
    }
  });

  it('propagates a seed failure so the container exits instead of booting half-seeded', async () => {
    const pool = poolWith();
    const failure = new Error('insert failed');
    const seedFn = vi.fn().mockRejectedValue(failure);

    await expect(seedDemoIfEmpty({ pool, seedFn })).rejects.toBe(failure);
  });

  it('propagates a guard-count failure', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const seedFn = vi.fn();

    await expect(seedDemoIfEmpty({ pool, seedFn })).rejects.toThrow(/connection refused/);
    expect(seedFn).not.toHaveBeenCalled();
  });
});
