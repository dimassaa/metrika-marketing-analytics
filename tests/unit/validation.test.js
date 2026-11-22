import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ValidationError } from '../../src/lib/errors.js';
import { parseQuery } from '../../src/lib/validation.js';
import {
  dashboardQuerySchema,
  parseChannelIds,
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
