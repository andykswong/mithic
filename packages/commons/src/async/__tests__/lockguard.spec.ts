import { describe, expect, it } from '@jest/globals';
import { LockGuard } from '../lockguard.ts';
import { CountingSemaphore } from '../semaphore.ts';

describe(LockGuard.name, () => {
  describe('acquire', () => {
    it('should return a LockGuard', async () => {
      const semaphore = new CountingSemaphore(1);
      {
        const guard = await LockGuard.acquire(semaphore);
        try {
          expect(semaphore['leased']).toBe(1);
        } finally {
          await guard.close();
        }
      }
      expect(semaphore['leased']).toBe(0);
    });
  });
});
