import { describe, expect, it } from 'vitest';
import { buildPeriodControl } from '../../src/services/metrics/screen-models.js';

describe('period control', () => {
  it('keeps the days select on a default page even when the controller resolved a period', () => {
    const control = buildPeriodControl({
      query: {},
      period: { from: '2026-10-24', to: '2026-11-22', days: 30 },
    });

    expect(control.customRange).toBeNull();
    expect(control.options.find((option) => option.value === 30).selected).toBe(true);
  });

  it('marks an explicit request range and links back to the default window', () => {
    const control = buildPeriodControl({
      query: { from: '2026-10-01', to: '2026-10-31' },
      period: { from: '2026-10-01', to: '2026-10-31', days: 31 },
    });

    expect(control.customRange).toMatchObject({ label: '01.10.2026 — 31.10.2026' });
    expect(control.customRange.href).toContain('days=30');
  });
});
