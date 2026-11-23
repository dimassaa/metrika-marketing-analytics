import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../../src/config/audit-actions.js';
import { METRICS_CONFIG } from '../../src/config/metrics.js';
import { createAuditService } from '../../src/services/audit.service.js';
import {
  scenarioSaveSchema,
  storedScenarioParamsSchema,
  storedScenarioResultSchema,
} from '../../src/validators/scenarios.schema.js';

/** Minimal valid `params` snapshot, mirroring what `saveScenario` writes for schema version 1. */
const PARAMS = {
  schemaVersion: 1,
  anchor: '2026-11-20',
  history: { from: '2026-05-18', to: '2026-11-15', weeks: METRICS_CONFIG.saturation.historyWeeks },
  budgetCents: '270571',
  channelIds: ['1', '2'],
  optimizer: { ...METRICS_CONFIG.saturation },
  budgetPeriod: 'week',
};

/** One saturation channel plus one excluded channel, enough to exercise every nullable field. */
const RESULT = {
  channels: [
    {
      channelId: '1',
      channelCode: 'google',
      channelName: 'Google Ads',
      model: 'saturation',
      K: 120,
      S: 2500,
      r2: 0.62,
      observed: [{ spendCents: '250000', customers: 74 }],
      current: { spendCents: '240000', customers: 70 },
      planned: { spendCents: '260000', customers: 76.5 },
      forecast: { customers: 76.5, revenue12Cents: '1530000', cacCents: '3399', romi12: -11.4 },
      note: null,
    },
    {
      channelId: '2',
      channelCode: 'seo',
      channelName: 'SEO',
      model: 'no_data',
      K: null,
      S: null,
      r2: null,
      observed: [{ spendCents: '0', customers: 12 }],
      current: { spendCents: '0', customers: 3 },
      planned: null,
      forecast: null,
      note: 'Нет данных для кривой',
    },
  ],
  totals: {
    current: { spendCents: '240000', customers: 70 },
    planned: { spendCents: '260000', customers: 76.5 },
    forecast: { customers: 76.5, revenue12Cents: '1530000', cacCents: '3399', romi12: -11.4 },
  },
  warnings: ['SEO: Нет данных для кривой'],
};

describe('stored scenario schemas', () => {
  it('accepts the version 1 params snapshot', () => {
    expect(storedScenarioParamsSchema.safeParse(PARAMS).success).toBe(true);
  });

  it('rejects another schema version instead of guessing', () => {
    expect(storedScenarioParamsSchema.safeParse({ ...PARAMS, schemaVersion: 2 }).success).toBe(false);
  });

  it('requires budgetCents to be a decimal string, never a float', () => {
    expect(storedScenarioParamsSchema.safeParse({ ...PARAMS, budgetCents: 270571 }).success).toBe(false);
    expect(storedScenarioParamsSchema.safeParse({ ...PARAMS, budgetCents: '2705.71' }).success).toBe(false);
  });

  it('rejects an unknown field at any level (strict)', () => {
    expect(
      storedScenarioParamsSchema.safeParse({ ...PARAMS, extra: true }).success,
    ).toBe(false);
    expect(
      storedScenarioResultSchema.safeParse({ ...RESULT, extra: true }).success,
    ).toBe(false);
    expect(
      storedScenarioResultSchema.safeParse({
        ...RESULT,
        channels: [{ ...RESULT.channels[0], extra: true }],
      }).success,
    ).toBe(false);
  });

  it('accepts the stored result with an excluded channel and rejects a missing note', () => {
    expect(storedScenarioResultSchema.safeParse(RESULT).success).toBe(true);

    const { note: _note, ...withoutNote } = RESULT.channels[1];
    expect(
      storedScenarioResultSchema.safeParse({
        ...RESULT,
        channels: [RESULT.channels[0], withoutNote],
      }).success,
    ).toBe(false);
  });

  it('rejects a forecast that carries a bigint-shaped number instead of a cents string', () => {
    expect(
      storedScenarioResultSchema.safeParse({
        ...RESULT,
        totals: { ...RESULT.totals, forecast: { ...RESULT.totals.forecast, revenue12Cents: 1530000 } },
      }).success,
    ).toBe(false);
  });
});

describe('scenario save schema', () => {
  it('trims the name and treats a blank budget as "current budget"', () => {
    const parsed = scenarioSaveSchema.parse({ name: '  План роста  ', budgetByn: '  ' });
    expect(parsed.name).toBe('План роста');
    expect(parsed.budgetByn).toBe('  ');
  });

  it('normalises a single channel field and removes duplicates', () => {
    expect(scenarioSaveSchema.parse({ name: 'Сценарий', channelIds: '5' }).channelIds).toEqual(['5']);
    expect(scenarioSaveSchema.parse({ name: 'Сценарий', channelIds: ['5', '007', '5'] }).channelIds).toEqual([
      '5',
      '7',
    ]);
    expect(scenarioSaveSchema.parse({ name: 'Сценарий', channelIds: '' }).channelIds).toBeNull();
  });

  it('rejects a name outside 3–120 characters and strips fields the service does not accept', () => {
    expect(scenarioSaveSchema.safeParse({ name: 'ab' }).success).toBe(false);
    expect(scenarioSaveSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);

    const parsed = scenarioSaveSchema.parse({
      name: 'Сценарий',
      _csrf: 'token',
      // A caller cannot smuggle a result through the form: the key is stripped before the service is called.
      result: { channels: [] },
    });
    expect(parsed).not.toHaveProperty('result');
    expect(parsed).not.toHaveProperty('_csrf');
  });
});

describe('audit vocabulary for decisions', () => {
  it('adds Russian labels for the scenario and alert actions and entities', () => {
    const auditService = createAuditService({ auditRepository: { async insert() {} } });
    const { actions, entities } = auditService.getFilterOptions();

    expect(AUDIT_ACTIONS.SCENARIO_CREATE).toBe('scenario.create');
    expect(AUDIT_ACTIONS.ALERT_DISMISS).toBe('alert.dismiss');
    expect(AUDIT_ENTITIES).toContain('scenario');
    expect(AUDIT_ENTITIES).toContain('alert');

    expect(actions).toContainEqual({ value: 'scenario.create', label: 'Создание сценария' });
    expect(actions).toContainEqual({ value: 'alert.dismiss', label: 'Закрытие алерта' });
    expect(entities).toContainEqual({ value: 'scenario', label: 'Сценарий' });
    expect(entities).toContainEqual({ value: 'alert', label: 'Алерт' });
  });
});
