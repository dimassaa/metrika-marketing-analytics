import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import {
  attributeOrders,
  createAttributionService,
} from '../../src/services/metrics/attribution.service.js';

const DAY_MS = 86_400_000;

/**
 * Builds one order fixture. Defaults keep the allocation tests focused on the touch set.
 * @param {object} [overrides]
 * @returns {{ orderId: string, customerId: string, firstChannelId: string | null, occurredAt: Date, revenueCents: bigint }}
 */
function order(overrides = {}) {
  return {
    orderId: '1',
    customerId: '7',
    firstChannelId: 'fallback',
    occurredAt: new Date('2026-11-10T12:00:00+03:00'),
    revenueCents: 10000n,
    ...overrides,
  };
}

/**
 * Builds one touchpoint fixture relative to the default order instant.
 * @param {{ touchpointId?: string, channelId?: string, customerId?: string, at?: Date }} [overrides]
 * @returns {{ touchpointId: string, customerId: string, channelId: string, occurredAt: Date }}
 */
function touch({ touchpointId = '1', channelId = '1', customerId = '7', at } = {}) {
  return {
    touchpointId,
    customerId,
    channelId,
    occurredAt: at ?? new Date('2026-11-09T12:00:00+03:00'),
  };
}

/**
 * Sums allocation rows per order id, so a property test can compare each order with its own revenue.
 * @param {Array<{ orderId: string, amountCents: bigint }>} rows
 * @returns {Map<string, bigint>}
 */
function sumByOrder(rows) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.orderId, (totals.get(row.orderId) ?? 0n) + row.amountCents);
  }
  return totals;
}

/**
 * Deterministic 200-order fixture. A small LCG keeps the distribution non-trivial without randomness, so a failure
 * is reproducible. Every order has a non-null `firstChannelId`, so no order can drop out of the allocation; the
 * property test can therefore assert `Σ attributed === Σ revenue` for each model.
 * @returns {{
 *   orders: Array<ReturnType<typeof order>>,
 *   touchpoints: Array<ReturnType<typeof touch>>,
 * }}
 */
function deterministicBook() {
  /** @type {Array<ReturnType<typeof order>>} */
  const orders = [];
  /** @type {Array<ReturnType<typeof touch>>} */
  const touchpoints = [];
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let customerIndex = 0; customerIndex < 20; customerIndex += 1) {
    const customerId = String(100 + customerIndex);
    const firstChannelId = String((customerIndex % 5) + 1);
    const touchCount = customerIndex % 4;

    for (let touchIndex = 0; touchIndex < touchCount; touchIndex += 1) {
      touchpoints.push(
        touch({
          touchpointId: String(customerIndex * 10 + touchIndex + 1),
          customerId,
          channelId: String(((customerIndex + touchIndex) % 5) + 1),
          at: new Date(Date.UTC(2026, 8, 1, 8, 0, 0) + (customerIndex * 36 + touchIndex * 7) * 3_600_000),
        }),
      );
    }

    for (let orderIndex = 0; orderIndex < 10; orderIndex += 1) {
      const orderNumber = customerIndex * 10 + orderIndex;
      orders.push(
        order({
          orderId: `order-${orderNumber}`,
          customerId,
          firstChannelId,
          occurredAt: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + orderNumber * 3_600_000),
          revenueCents: 1000n + BigInt(Math.floor(next() * 5000)),
        }),
      );
    }
  }

  return { orders, touchpoints };
}

describe('attributeOrders', () => {
  it('splits 10 000 c across three touches as 3334 / 3333 / 3333', () => {
    const rows = attributeOrders({
      orders: [order()],
      touchpoints: [
        touch({ touchpointId: '1', channelId: 'a', at: new Date('2026-11-08T12:00:00+03:00') }),
        touch({ touchpointId: '2', channelId: 'b', at: new Date('2026-11-09T12:00:00+03:00') }),
        touch({ touchpointId: '3', channelId: 'c', at: new Date('2026-11-10T09:00:00+03:00') }),
      ],
      model: 'linear',
    });

    expect(rows).toEqual([
      { orderId: '1', channelId: 'a', amountCents: 3334n },
      { orderId: '1', channelId: 'b', amountCents: 3333n },
      { orderId: '1', channelId: 'c', amountCents: 3333n },
    ]);
  });

  it('keeps the remainder cent on the earliest touch for 10 001 c and two touches', () => {
    const rows = attributeOrders({
      orders: [order({ revenueCents: 10001n })],
      touchpoints: [
        touch({ touchpointId: '1', channelId: 'a', at: new Date('2026-11-09T12:00:00+03:00') }),
        touch({ touchpointId: '2', channelId: 'b', at: new Date('2026-11-10T09:00:00+03:00') }),
      ],
      model: 'linear',
    });

    expect(rows).toEqual([
      { orderId: '1', channelId: 'a', amountCents: 5001n },
      { orderId: '1', channelId: 'b', amountCents: 5000n },
    ]);
  });

  it('gives the whole order to the last or the first touch', () => {
    const touchpoints = [
      touch({ touchpointId: '1', channelId: 'a', at: new Date('2026-11-08T12:00:00+03:00') }),
      touch({ touchpointId: '2', channelId: 'b', at: new Date('2026-11-10T09:00:00+03:00') }),
    ];

    expect(attributeOrders({ orders: [order()], touchpoints, model: 'last_touch' })).toEqual([
      { orderId: '1', channelId: 'b', amountCents: 10000n },
    ]);
    expect(attributeOrders({ orders: [order()], touchpoints, model: 'first_touch' })).toEqual([
      { orderId: '1', channelId: 'a', amountCents: 10000n },
    ]);
  });

  it('falls back to the acquisition channel when the window has no touches', () => {
    for (const model of ['last_touch', 'first_touch', 'linear']) {
      expect(
        attributeOrders({
          orders: [order({ firstChannelId: 'fallback' })],
          touchpoints: [touch({ at: new Date('2026-10-01T12:00:00+03:00') })],
          model,
        }),
      ).toEqual([{ orderId: '1', channelId: 'fallback', amountCents: 10000n }]);
    }
  });

  it('includes a touch exactly 30 days before the order and excludes one millisecond older', () => {
    const at = new Date('2026-11-10T12:00:00+03:00');
    const rows = attributeOrders({
      orders: [order({ occurredAt: at })],
      touchpoints: [
        touch({ touchpointId: '1', channelId: 'old', at: new Date(at.getTime() - 30 * DAY_MS - 1) }),
        touch({ touchpointId: '2', channelId: 'edge', at: new Date(at.getTime() - 30 * DAY_MS) }),
      ],
      model: 'first_touch',
    });

    expect(rows).toEqual([{ orderId: '1', channelId: 'edge', amountCents: 10000n }]);
  });

  it('includes a touch exactly at the order instant and ignores any touch after it', () => {
    const at = new Date('2026-11-10T12:00:00+03:00');
    const rows = attributeOrders({
      orders: [order({ occurredAt: at })],
      touchpoints: [
        touch({ touchpointId: '1', channelId: 'before', at: new Date(at.getTime() - 1_000) }),
        touch({ touchpointId: '2', channelId: 'exact', at }),
        touch({ touchpointId: '3', channelId: 'after', at: new Date(at.getTime() + 1) }),
        touch({ touchpointId: '4', channelId: 'much_after', at: new Date(at.getTime() + 3_600_000) }),
      ],
      model: 'last_touch',
    });

    expect(rows).toEqual([{ orderId: '1', channelId: 'exact', amountCents: 10000n }]);
  });

  it('includes a touch exactly at the order instant for the first-touch model too', () => {
    const at = new Date('2026-11-10T12:00:00+03:00');

    expect(
      attributeOrders({
        orders: [order({ occurredAt: at })],
        touchpoints: [
          touch({ touchpointId: '1', channelId: 'after', at: new Date(at.getTime() + 1) }),
          touch({ touchpointId: '2', channelId: 'exact', at }),
        ],
        model: 'first_touch',
      }),
    ).toEqual([{ orderId: '1', channelId: 'exact', amountCents: 10000n }]);
  });

  it('omits an order that has neither a touch nor an acquisition channel', () => {
    const rows = attributeOrders({
      orders: [order({ firstChannelId: null })],
      touchpoints: [],
      model: 'linear',
    });

    expect(rows).toEqual([]);
  });

  it('ignores touchpoints of another customer', () => {
    const rows = attributeOrders({
      orders: [order({ customerId: '7' })],
      touchpoints: [
        touch({ touchpointId: '1', customerId: '8', channelId: 'other' }),
        touch({ touchpointId: '2', customerId: '7', channelId: 'mine' }),
      ],
      model: 'last_touch',
    });

    expect(rows).toEqual([{ orderId: '1', channelId: 'mine', amountCents: 10000n }]);
  });

  it('does not produce negative shares for a zero-revenue order', () => {
    const rows = attributeOrders({
      orders: [order({ revenueCents: 0n })],
      touchpoints: [
        touch({ touchpointId: '1', channelId: 'a' }),
        touch({ touchpointId: '2', channelId: 'b' }),
        touch({ touchpointId: '3', channelId: 'c' }),
      ],
      model: 'linear',
    });

    expect(rows.map((row) => row.amountCents)).toEqual([0n, 0n, 0n]);
    expect(rows.every((row) => row.amountCents >= 0n)).toBe(true);
  });

  it('breaks equal instants by numeric touchpoint id, so id 9 goes before id 10', () => {
    const sameInstant = new Date('2026-11-10T09:00:00+03:00');

    const linear = attributeOrders({
      orders: [order({ revenueCents: 3n })],
      touchpoints: [
        touch({ touchpointId: '10', channelId: 'ten', at: sameInstant }),
        touch({ touchpointId: '9', channelId: 'nine', at: sameInstant }),
      ],
      model: 'linear',
    });
    expect(linear).toEqual([
      { orderId: '1', channelId: 'nine', amountCents: 2n },
      { orderId: '1', channelId: 'ten', amountCents: 1n },
    ]);

    expect(
      attributeOrders({
        orders: [order()],
        touchpoints: [
          touch({ touchpointId: '10', channelId: 'ten', at: sameInstant }),
          touch({ touchpointId: '9', channelId: 'nine', at: sameInstant }),
        ],
        model: 'first_touch',
      }),
    ).toEqual([{ orderId: '1', channelId: 'nine', amountCents: 10000n }]);
  });

  it('keeps Σ amountCents per order and per model equal to revenue on 200 deterministic orders', () => {
    const { orders, touchpoints } = deterministicBook();
    const expectedTotal = orders.reduce((sum, entry) => sum + entry.revenueCents, 0n);

    for (const model of ['last_touch', 'first_touch', 'linear']) {
      const rows = attributeOrders({ orders, touchpoints, model });
      const perOrder = sumByOrder(rows);

      for (const entry of orders) {
        expect(perOrder.get(entry.orderId)).toBe(entry.revenueCents);
      }
      expect(rows.reduce((sum, row) => sum + row.amountCents, 0n)).toBe(expectedTotal);
    }
  });

  it('rejects an unknown model loudly instead of guessing', () => {
    expect(() => attributeOrders({ orders: [order()], touchpoints: [], model: 'time_decay' })).toThrow(TypeError);
  });
});

/**
 * Minimal repository stubs. The service must depend on method contracts only, never on `pg`.
 * @param {{
 *   orders?: object[],
 *   touchpoints?: object[],
 *   channels?: Array<{ id: string, code: string }>,
 *   spend?: Array<{ channelId: string, channelCode: string, spendCents: bigint }>,
 * }} [fixtures]
 */
function fakeRepositories({ orders = [], touchpoints = [], channels = [], spend = [] } = {}) {
  return {
    attributionRepository: {
      listOrdersInPeriod: async () => orders,
      listTouchpointsForOrders: async () => touchpoints,
    },
    metricsRepository: {
      listChannelSpend: async () => spend,
    },
    channelsRepository: {
      listChannels: async () => channels,
    },
  };
}

/**
 * Two-channel book used by the service tests:
 * - order 1: 10 000 c, three touches (instagram, email, instagram) → linear 6 667 / 3 333;
 * - order 2: 0 c without touches, so the acquisition fallback contributes an honest zero, not a negative share;
 * - order 3: 2 500 c, one email touch in the next week.
 * @returns {ReturnType<typeof fakeRepositories>}
 */
function serviceFixtures() {
  return fakeRepositories({
    channels: [
      { id: '2', code: 'email' },
      { id: '1', code: 'instagram' },
    ],
    spend: [
      { channelId: '1', channelCode: 'instagram', spendCents: 5000n },
      { channelId: '2', channelCode: 'email', spendCents: 0n },
    ],
    orders: [
      order({
        orderId: '1',
        customerId: '7',
        firstChannelId: '1',
        revenueCents: 10000n,
        occurredAt: new Date('2026-11-10T12:00:00+03:00'),
      }),
      order({
        orderId: '2',
        customerId: '8',
        firstChannelId: '2',
        revenueCents: 0n,
        occurredAt: new Date('2026-11-11T12:00:00+03:00'),
      }),
      order({
        orderId: '3',
        customerId: '9',
        firstChannelId: '2',
        revenueCents: 2500n,
        occurredAt: new Date('2026-11-17T12:00:00+03:00'),
      }),
    ],
    touchpoints: [
      touch({ touchpointId: '1', customerId: '7', channelId: '1', at: new Date('2026-11-08T12:00:00+03:00') }),
      touch({ touchpointId: '2', customerId: '7', channelId: '2', at: new Date('2026-11-09T12:00:00+03:00') }),
      touch({ touchpointId: '3', customerId: '7', channelId: '1', at: new Date('2026-11-10T09:00:00+03:00') }),
      touch({ touchpointId: '4', customerId: '9', channelId: '2', at: new Date('2026-11-17T10:00:00+03:00') }),
    ],
  });
}

describe('createAttributionService report', () => {
  it('builds all three models and holds the money invariant per model', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({
      from: '2026-11-01',
      to: '2026-11-21',
    });

    expect(report.period).toEqual({ from: '2026-11-01', to: '2026-11-21' });
    expect(Object.keys(report.models)).toEqual(['last_touch', 'first_touch', 'linear']);

    for (const model of Object.values(report.models)) {
      expect(BigInt(model.totalRevenueCents)).toBe(12500n);
      expect(model.totalAttributedCents).toBe(model.totalRevenueCents);
      expect(model.revenueByChannel.reduce((sum, row) => sum + BigInt(row.revenueCents), 0n)).toBe(12500n);
    }

    expect(report.models.last_touch.revenueByChannel).toEqual([
      { channelId: '2', channelCode: 'email', revenueCents: '2500', romiPct: null },
      { channelId: '1', channelCode: 'instagram', revenueCents: '10000', romiPct: 100 },
    ]);
    expect(report.models.linear.revenueByChannel).toEqual([
      { channelId: '2', channelCode: 'email', revenueCents: '5833', romiPct: null },
      { channelId: '1', channelCode: 'instagram', revenueCents: '6667', romiPct: 33.34 },
    ]);
  });

  it('compares every channel against the default last-touch model', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({ from: '2026-11-01', to: '2026-11-21' });

    expect(report.comparison).toEqual([
      {
        channelId: '2',
        channelCode: 'email',
        lastTouchCents: '2500',
        firstTouchCents: '2500',
        linearCents: '5833',
        deltaModel: 'linear',
        deltaLinearVsLastCents: '3333',
        deltaLinearVsLastPct: 133.32,
      },
      {
        channelId: '1',
        channelCode: 'instagram',
        lastTouchCents: '10000',
        firstTouchCents: '10000',
        linearCents: '6667',
        deltaModel: 'linear',
        deltaLinearVsLastCents: '-3333',
        deltaLinearVsLastPct: -33.33,
      },
    ]);
  });

  it('returns only the requested model in the map but keeps the comparison complete', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({
      from: '2026-11-01',
      to: '2026-11-21',
      models: ['linear'],
    });

    expect(Object.keys(report.models)).toEqual(['linear']);
    expect(report.comparison[0]).toMatchObject({
      channelCode: 'email',
      lastTouchCents: '2500',
      firstTouchCents: '2500',
      linearCents: '5833',
      deltaModel: 'linear',
      deltaLinearVsLastCents: '3333',
    });
  });

  it('leaves ROMI null when the channel has no spend', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({ from: '2026-11-01', to: '2026-11-21' });

    const email = report.models.last_touch.revenueByChannel.find((row) => row.channelCode === 'email');
    expect(email.romiPct).toBeNull();
  });

  it('serialises without NaN or Infinity', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({ from: '2026-11-01', to: '2026-11-21' });

    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
  });

  it('validates the period and the model list', async () => {
    const service = createAttributionService(serviceFixtures());

    await expect(service.getAttributionReport({ from: '2026-11-21', to: '2026-11-01' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.getAttributionReport({ from: '2026-11-01', to: '2026-11-21', models: ['time_decay'] }))
      .rejects.toBeInstanceOf(ValidationError);
  });
});

describe('createAttributionService series', () => {
  it('groups the linear shares into Monday-based weeks that sum to the model total', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({ from: '2026-11-01', to: '2026-11-21' });
    const series = await service.getAttributionSeries({
      from: '2026-11-01',
      to: '2026-11-21',
      model: 'linear',
    });

    expect(series).toEqual([
      { weekStart: '2026-11-09', revenueCents: '10000' },
      { weekStart: '2026-11-16', revenueCents: '2500' },
    ]);
    expect(series.every((row) => ['2026-11-09', '2026-11-16'].includes(row.weekStart))).toBe(true);
    expect(series.reduce((sum, row) => sum + BigInt(row.revenueCents), 0n)).toBe(
      BigInt(report.models.linear.totalAttributedCents),
    );
  });

  it('filters by channel after allocation without losing kopecks', async () => {
    const service = createAttributionService(serviceFixtures());
    const report = await service.getAttributionReport({ from: '2026-11-01', to: '2026-11-21' });
    const series = await service.getAttributionSeries({
      from: '2026-11-01',
      to: '2026-11-21',
      model: 'linear',
      channelId: '2',
    });

    const expected = report.models.linear.revenueByChannel.find((row) => row.channelId === '2');
    expect(series).toEqual([
      { weekStart: '2026-11-09', revenueCents: '3333' },
      { weekStart: '2026-11-16', revenueCents: '2500' },
    ]);
    expect(series.reduce((sum, row) => sum + BigInt(row.revenueCents), 0n)).toBe(BigInt(expected.revenueCents));
  });

  it('rejects an invalid channel id', async () => {
    const service = createAttributionService(serviceFixtures());

    await expect(
      service.getAttributionSeries({ from: '2026-11-01', to: '2026-11-21', channelId: 'abc' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
