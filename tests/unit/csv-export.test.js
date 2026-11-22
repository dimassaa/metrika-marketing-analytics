import { describe, expect, it, vi } from 'vitest';
import { stringifyCsv } from '../../src/lib/csv.js';
import { minskDayStart } from '../../src/lib/dates.js';
import { createExportService, EXPORT_ROW_LIMIT } from '../../src/services/export.service.js';
import { createExportController } from '../../src/controllers/export.controller.js';

/**
 * @param {unknown} value
 * @returns {string} Raw serialised cell, as it appears between the header and the trailing CRLF.
 */
function serialisedCell(value) {
  const output = stringifyCsv(['value'], [[value]]);
  return output.slice('\uFEFFvalue\r\n'.length, -'\r\n'.length);
}

describe('stringifyCsv formula injection', () => {
  const dangerous = [
    ['=', '=1+1', "'=1+1"],
    ['+', '+SUM(A1:A2)', "'+SUM(A1:A2)"],
    ['-', '-cmd', "'-cmd"],
    ['@', '@cmd', "'@cmd"],
    ['TAB', '\tcmd', "'\tcmd"],
    // A CR makes the cell quoted as well, so the apostrophe stays inside the field.
    ['CR', '\r=1+1', '"\'\r=1+1"'],
  ];

  it.each(dangerous)('prefixes a cell starting with %s with an apostrophe', (_label, input, expected) => {
    expect(serialisedCell(input)).toBe(expected);
  });

  it('leaves real negative numbers numeric, whether string, number or bigint', () => {
    expect(serialisedCell('-12,34')).toBe('-12,34');
    expect(serialisedCell('-7')).toBe('-7');
    expect(serialisedCell(-5)).toBe('-5');
    expect(serialisedCell(-5n)).toBe('-5');
  });

  it('does not touch ordinary text and already-safe ids', () => {
    expect(serialisedCell('Instagram')).toBe('Instagram');
    expect(serialisedCell('zerna_customer_0001')).toBe('zerna_customer_0001');
  });
});

/** @returns {ReturnType<typeof createExportService>['exportDataset']} */
function serviceWithRepositories({ rowLimit, repository, reference = { getDataAnchor: async () => '2026-11-20' } }) {
  return createExportService({ exportRepository: repository, referenceRepository: reference, rowLimit }).exportDataset;
}

/**
 * Fake rows shaped like each repository method. One extra row beyond the cap is what the service must detect.
 * @param {number} limit
 * @param {string} dataset
 * @returns {Array<Record<string, any>>}
 */
function fakeRows(limit, dataset) {
  return Array.from({ length: limit }, (_, index) => {
    if (dataset === 'channels') {
      return {
        code: `ch_${index}`,
        name: `Channel ${index}`,
        kind: 'paid',
        isActive: true,
        targetCacCents: 100n,
        targetRomiPct: '120.00',
        campaignsCount: 1,
      };
    }
    if (dataset === 'campaigns') {
      return {
        code: `cp_${index}`,
        name: `Campaign ${index}`,
        channelCode: 'ch',
        status: 'active',
        startedOn: '2026-11-01',
        endedOn: null,
        budgetCents: 100n,
        spendCents: 50n,
      };
    }
    if (dataset === 'daily_stats') {
      return {
        statDate: '2026-11-01',
        channelCode: 'ch',
        campaignCode: 'cp',
        impressions: 10,
        clicks: 2,
        leads: 1,
        spendCents: 100n,
      };
    }
    return {
      externalId: `ord_${index}`,
      customerExternalId: `cus_${index}`,
      firstChannelCode: 'ch',
      campaignCode: 'cp',
      occurredAt: '2026-11-01T10:00:00+03:00',
      revenueCents: 1000n,
      marginCents: 400n,
    };
  });
}

describe('export service row cap', () => {
  it.each(['channels', 'campaigns', 'daily_stats', 'orders'])(
    'detects truncation for %s by fetching limit + 1 and dropping the probe',
    async (dataset) => {
      const seen = {};
      const repository = {
        listChannels: vi.fn(async ({ limit }) => {
          seen.limit = limit;
          return fakeRows(limit, 'channels');
        }),
        listCampaigns: vi.fn(async ({ limit }) => {
          seen.limit = limit;
          return fakeRows(limit, 'campaigns');
        }),
        listDailyStats: vi.fn(async ({ limit }) => {
          seen.limit = limit;
          return fakeRows(limit, 'daily_stats');
        }),
        listOrders: vi.fn(async ({ limit }) => {
          seen.limit = limit;
          return fakeRows(limit, 'orders');
        }),
      };

      const result = await serviceWithRepositories({ rowLimit: 2, repository })({ dataset, filters: {} });

      expect(seen.limit).toBe(3);
      expect(result).toMatchObject({ rowsCount: 2, truncated: true, limit: 2 });
      expect(result.csvContent.split('\r\n')).toHaveLength(4); // header + 2 rows + trailing empty string
    },
  );

  it('reports no truncation when the probe row is absent', async () => {
    const repository = {
      listChannels: vi.fn(async () => fakeRows(1, 'channels')),
    };

    const result = await serviceWithRepositories({ rowLimit: 2, repository })({ dataset: 'channels', filters: {} });

    expect(result).toMatchObject({ rowsCount: 1, truncated: false, limit: 2 });
    expect(EXPORT_ROW_LIMIT).toBe(50_000);
  });

  it('passes half-open Minsk instants for the order date filter', async () => {
    let captured;
    const repository = {
      listOrders: vi.fn(async (args) => {
        captured = args;
        return [];
      }),
    };

    await serviceWithRepositories({ rowLimit: 10, repository })({
      dataset: 'orders',
      filters: { from: '2026-11-01', to: '2026-11-02' },
    });

    expect(captured.fromInstant.toISOString()).toBe(minskDayStart('2026-11-01').toISOString());
    expect(captured.toExclusive.toISOString()).toBe(minskDayStart('2026-11-03').toISOString());
  });
});

/**
 * Minimal response double: records headers and the body without starting Express.
 * @returns {{ headers: Record<string, string>, body?: string, setHeader: Function, send: Function }}
 */
function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    send(body) {
      this.body = body;
    },
  };
}

describe('export controller truncation headers', () => {
  const filters = { from: null, to: null, channelId: null };

  /**
   * @param {boolean} truncated
   * @returns {Promise<{ res: ReturnType<typeof fakeResponse>, audit: Record<string, unknown> }>}
   */
  async function run(truncated) {
    let audit;
    const controller = createExportController({
      exportService: {
        exportDataset: async () => ({
          filename: 'metrika-orders-2026-11-20.csv',
          csvContent: '\uFEFFa\r\n1\r\n',
          rowsCount: 2,
          truncated,
          limit: 2,
        }),
      },
      auditService: {
        record: async (entry) => {
          audit = entry;
        },
      },
    });
    const res = fakeResponse();
    await controller.download(
      { params: { dataset: 'orders' }, query: {}, session: { user: { id: '7' } }, ip: '127.0.0.1' },
      res,
    );
    return { res, audit };
  }

  it('emits both cap headers and audits the truncation', async () => {
    const { res, audit } = await run(true);

    expect(res.headers['x-row-limit']).toBe('2');
    expect(res.headers['x-row-truncated']).toBe('true');
    expect(audit.payload).toEqual({ filters, rowsCount: 2, truncated: true });
    expect(audit.entity).toBe('orders');
  });

  it('emits neither cap header for an ordinary download', async () => {
    const { res, audit } = await run(false);

    expect(res.headers['x-row-limit']).toBeUndefined();
    expect(res.headers['x-row-truncated']).toBeUndefined();
    expect(audit.payload).toEqual({ filters, rowsCount: 2, truncated: false });
  });
});
