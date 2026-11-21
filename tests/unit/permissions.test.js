import { describe, expect, it } from 'vitest';
import { can } from '../../src/config/permissions.js';

describe('permission matrix', () => {
  it('lets an admin manage users', () => {
    expect(can('admin', 'users:manage')).toBe(true);
  });

  it('does not let an analyst manage users', () => {
    expect(can('analyst', 'users:manage')).toBe(false);
  });

  it('lets an analyst run an import', () => {
    expect(can('analyst', 'import:run')).toBe(true);
  });

  it('does not let a viewer manage channels', () => {
    expect(can('viewer', 'channels:manage')).toBe(false);
  });

  it('lets a viewer open the dashboard', () => {
    expect(can('viewer', 'dashboard:view')).toBe(true);
  });
});
