import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ValidationError } from '../../src/lib/errors.js';
import { parseQuery } from '../../src/lib/validation.js';
import {
  dashboardQuerySchema,
  channelsPageQuerySchema,
  channelsQuerySchema,
  parseChannelIds,
  parseWeightParams,
  periodQuerySchema,
} from '../../src/validators/metrics.schema.js';

describe('parseQuery', () => {
  it('returns parsed and transformed data for a valid query', () => {
    expect(parseQuery(dashboardQuerySchema, { days: '90' })).toEqual({
      days: 90,
      channelIds: null,
    });
  });

  it('turns the first Zod issue into a 400 with a Russian message, never a raw ZodError', () => {
    let thrown;
    try {
      parseQuery(dashboardQuerySchema, { days: '45' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect(thrown).not.toBeInstanceOf(ZodError);
    expect(thrown.statusCode).toBe(400);
    expect(thrown.code).toBe('VALIDATION_ERROR');
    expect(thrown.message).toMatch(/[А-Яа-яЁё]/);
    // The original error stays available for logs, but the caller never sees Zod's shape.
    expect(thrown.cause).toBeInstanceOf(ZodError);
  });

  it('rejects days together with an explicit from/to', () => {
    expect(() => parseQuery(dashboardQuerySchema, { days: '30', from: '2026-10-01' })).toThrow(
      /days/,
    );
    expect(() => parseQuery(periodQuerySchema, { days: '30', to: '2026-10-31' })).toThrow(
      ValidationError,
    );
  });

  it('accepts from without to, because the resolver fills the missing side', () => {
    expect(parseQuery(periodQuerySchema, { from: '2026-10-01' })).toEqual({ from: '2026-10-01' });
  });

  it('rejects a date that is not YYYY-MM-DD with a Russian message', () => {
    expect(() => parseQuery(periodQuerySchema, { from: '01.10.2026' })).toThrow(/ГГГГ-ММ-ДД/);
  });
});

describe('channelIds', () => {
  it('accepts repeated and comma-separated ids as the same filter', () => {
    const repeated = parseQuery(dashboardQuerySchema, { channelIds: ['1', '2'] });
    const comma = parseQuery(dashboardQuerySchema, { channelIds: '1,2' });
    const mixed = parseQuery(dashboardQuerySchema, { channelIds: ['1,2', '3'] });

    expect(repeated.channelIds).toEqual(['1', '2']);
    expect(comma.channelIds).toEqual(['1', '2']);
    expect(mixed.channelIds).toEqual(['1', '2', '3']);
  });

  it('deduplicates a repeated id and normalises leading zeros', () => {
    expect(parseChannelIds(['007', '7', '8'])).toEqual(['7', '8']);
  });

  it('rejects an empty parameter instead of silently widening to all channels', () => {
    expect(() => parseQuery(dashboardQuerySchema, { channelIds: '' })).toThrow(ValidationError);
    expect(() => parseQuery(dashboardQuerySchema, {})).not.toThrow();
    expect(parseQuery(dashboardQuerySchema, {}).channelIds).toBeNull();
  });

  it('rejects a non-numeric or out-of-range id with a 400', () => {
    expect(() => parseChannelIds('abc')).toThrow(ValidationError);
    expect(() => parseChannelIds('0')).toThrow(ValidationError);
    expect(() => parseChannelIds('99999999999999999999')).toThrow(ValidationError);
    expect(() => parseQuery(dashboardQuerySchema, { channelIds: '12x' })).toThrow(ValidationError);
  });
});

describe('ranking weights in the query string', () => {
  it('defaults when none of the four parameters is present', () => {
    expect(parseWeightParams({})).toEqual({ cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 });
    expect(parseWeightParams()).toEqual({ cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 });
  });

  it('converts percentages into fractions and accepts a zero-sum-free set', () => {
    expect(parseWeightParams({ wCac: '0', wRomi: '100', wLtvCac: '0', wNewCustomers: '0' })).toEqual({
      cac: 0,
      romi: 1,
      ltvCac: 0,
      newCustomers: 0,
    });
    expect(parseWeightParams({ wCac: '10', wRomi: '20', wLtvCac: '30', wNewCustomers: '40' })).toEqual({
      cac: 0.1,
      romi: 0.2,
      ltvCac: 0.3,
      newCustomers: 0.4,
    });
  });

  it('rejects a partial set, a non-numeric value and a zero total', () => {
    expect(() => parseWeightParams({ wCac: '10' })).toThrow(/все четыре веса/);
    expect(() => parseWeightParams({ wCac: 'abc', wRomi: '20', wLtvCac: '30', wNewCustomers: '40' })).toThrow(
      /должен быть числом/,
    );
    expect(() => parseWeightParams({ wCac: '-1', wRomi: '20', wLtvCac: '30', wNewCustomers: '40' })).toThrow(
      /от 0 до 100/,
    );
    expect(() => parseWeightParams({ wCac: '0', wRomi: '0', wLtvCac: '0', wNewCustomers: '0' })).toThrow(
      /больше нуля/,
    );
  });

  it('keeps the API strict and the page tolerant for stale status bookmarks', () => {
    expect(() => parseQuery(channelsQuerySchema, { status: 'bogus' })).toThrow(ValidationError);
    expect(parseQuery(channelsPageQuerySchema, { status: 'bogus' }).status).toBe('all');
    expect(parseQuery(channelsPageQuerySchema, { sort: 'cac', dir: 'asc' })).toMatchObject({
      sort: 'cac',
      dir: 'asc',
    });
    expect(parseQuery(channelsQuerySchema, {})).toMatchObject({
      status: 'all',
      kind: 'all',
      sort: 'rank',
      dir: 'asc',
      weightsCustom: false,
    });
  });
});
