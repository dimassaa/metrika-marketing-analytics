import { describe, expect, it, vi } from 'vitest';
import { removeRestoreDirectory } from '../../scripts/restore.js';

/**
 * The restore script decrypts the dump into a temporary directory. Its `finally` block is the only thing that
 * removes the plaintext copy, so the retry and the failure signal are load-bearing: a single transient lock must not
 * leave a decryptable dump behind, and a permanent failure must fail the command instead of printing a warning.
 */
describe('restore temporary directory cleanup', () => {
  it('removes the directory on the first attempt', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(removeRestoreDirectory('/tmp/metrika-restore-x', { remove, delayMs: 0 })).resolves.toEqual({
      removed: true,
      attempts: 1,
    });
    expect(remove).toHaveBeenCalledWith('/tmp/metrika-restore-x', { recursive: true, force: true });
  });

  it('retries once when the first removal fails', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new Error('EBUSY')).mockResolvedValueOnce(undefined);

    await expect(removeRestoreDirectory('/tmp/metrika-restore-x', { remove, delayMs: 0 })).resolves.toEqual({
      removed: true,
      attempts: 2,
    });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('reports a permanent failure after the retry', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('EPERM'));

    await expect(removeRestoreDirectory('/tmp/metrika-restore-x', { remove, delayMs: 0 })).resolves.toEqual({
      removed: false,
      attempts: 2,
      error: 'EPERM',
    });
  });
});
