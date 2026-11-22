import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/csv.js';
import { ValidationError } from '../../src/lib/errors.js';
import { parseImportFile, validateImportRow } from '../../src/validators/import.schema.js';

describe('parseCsv', () => {
  it('strips the UTF-8 BOM, splits on ";" and numbers data rows from the file line', () => {
    const parsed = parseCsv('\uFEFFcampaign_code;stat_date\ninstagram_retarget;2024-01-01');

    expect(parsed.headers).toEqual(['campaign_code', 'stat_date']);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].rowNumber).toBe(2);
    expect(parsed.rows[0].values).toEqual({
      campaign_code: 'instagram_retarget',
      stat_date: '2024-01-01',
    });
  });

  it('accepts CRLF and keeps a semicolon inside quoted fields', () => {
    const parsed = parseCsv('a;b\r\n1;"Минск; центр"\r\n');

    expect(parsed.rows[0].values.b).toBe('Минск; центр');
    expect(parsed.rows[0].values.b).not.toContain('\r');
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    const parsed = parseCsv('a;b\n1;"ООО ""Зёрна"""');

    expect(parsed.rows[0].values.b).toBe('ООО "Зёрна"');
  });

  it('rejects a file above the row limit', () => {
    const csv = ['a;b', ...Array.from({ length: 10_001 }, (_, index) => `1;${index}`)].join('\n');

    expect(() => parseCsv(csv)).toThrow(ValidationError);
    expect(() => parseCsv(csv)).toThrow('Превышен лимит 10 000 строк');
  });

  it('rejects an unclosed quoted field instead of guessing the rest of the file', () => {
    expect(() => parseCsv('a;b\n1;"open')).toThrow(ValidationError);
  });
});

describe('validateImportRow', () => {
  it('parses a daily_stats spend with a space-grouped comma amount into kopecks', () => {
    const row = validateImportRow(
      'daily_stats',
      {
        campaign_code: 'instagram_retarget',
        stat_date: '2024-01-01',
        impressions: '12000',
        clicks: '340',
        leads: '28',
        spend: '1 200,50',
      },
    );

    expect(row.spendCents).toBe(120050n);
    expect(row.impressions).toBe(12000);
    expect(row.statDate).toBe('2024-01-01');
  });

  it('rejects an order whose margin exceeds revenue', () => {
    expect(() =>
      validateImportRow(
        'orders',
        {
          external_id: 'o1',
          customer_external_id: 'c1',
          campaign_code: '',
          occurred_at: '2026-11-05T10:00:00+03:00',
          revenue: '100,00',
          margin: '140,00',
        },
      ),
    ).toThrow('Маржа не может превышать выручку');
  });

  it('rejects a negative amount', () => {
    expect(() =>
      validateImportRow(
        'orders',
        {
          external_id: 'o1',
          customer_external_id: 'c1',
          campaign_code: '',
          occurred_at: '2026-11-05T10:00:00+03:00',
          revenue: '-1',
          margin: '0',
        },
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a timestamp without an explicit offset', () => {
    expect(() =>
      validateImportRow(
        'orders',
        {
          external_id: 'o1',
          customer_external_id: 'c1',
          campaign_code: '',
          occurred_at: '2026-11-05T10:00:00',
          revenue: '100',
          margin: '40',
        },
      ),
    ).toThrow('часовым поясом');
  });

  it('rejects a touchpoint kind outside the closed list', () => {
    expect(() =>
      validateImportRow(
        'touchpoints',
        {
          customer_external_id: 'c1',
          channel_code: 'instagram',
          campaign_code: '',
          occurred_at: '2026-11-05T10:00:00Z',
          kind: 'clicked',
        },
      ),
    ).toThrow('click, impression или visit');
  });
});

describe('parseImportFile', () => {
  const ordersHeader = 'external_id;customer_external_id;campaign_code;occurred_at;revenue;margin';

  it('reports extra columns as warnings and still validates the rows', () => {
    const parsed = parseImportFile(
      'orders',
      `${ordersHeader};note\nm2_w1;m2_c1;;2026-11-05T10:00:00Z;100,00;40,00;подарок`,
    );

    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('note');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rowsTotal).toBe(1);
    expect(parsed.rows[0].data.revenueCents).toBe(10000n);
  });

  it('rejects a file that misses a required column', () => {
    expect(() =>
      parseImportFile(
        'daily_stats',
        'campaign_code;stat_date;impressions;clicks;leads\ninstagram_retarget;2024-01-01;1;1;1',
      ),
    ).toThrow(ValidationError);
    expect(() =>
      parseImportFile(
        'daily_stats',
        'campaign_code;stat_date;impressions;clicks;leads\ninstagram_retarget;2024-01-01;1;1;1',
      ),
    ).toThrow('spend');
  });

  it('rejects an unknown kind', () => {
    expect(() => parseImportFile('invoices', 'a;b\n1;2')).toThrow(ValidationError);
  });

  it('collects field errors with the physical row number and keeps valid rows', () => {
    const parsed = parseImportFile(
      'orders',
      [
        ordersHeader,
        'm2_w1;m2_c1;;2026-11-05T10:00:00Z;100;40',
        'm2_w2;m2_c1;;2026-11-05T10:00:00;100;40',
        'm2_w3;m2_c1;;2026-11-05T10:00:00Z;100;400',
      ].join('\n'),
    );

    expect(parsed.rowsTotal).toBe(3);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors.map((error) => error.row)).toEqual([3, 4]);
    expect(parsed.errors.map((error) => error.field)).toEqual(['occurred_at', 'margin']);
  });

  it('treats a row with the wrong number of columns as a row error', () => {
    const parsed = parseImportFile('orders', [ordersHeader, 'm2_w1;m2_c1;;2026-11-05T10:00:00Z;100'].join('\n'));

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0].row).toBe(2);
    expect(parsed.errors[0].message).toContain('колонок');
  });
});
