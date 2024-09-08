import { describe, expect, it } from '@jest/globals';
import { LockGuard } from '../lockguard.ts';
import { AtomicSemaphore } from '../semaphore.ts';

describe(LockGuard.name, () => {
  describe('acquire', () => {
    it('should return a LockGuard', async () => {
      const counter = new Int32Array(new SharedArrayBuffer(4));
      counter[0] = 1;
      const semaphore = new AtomicSemaphore({ buffer: counter });
      {
        await using _ = await LockGuard.acquire(semaphore);
        expect(counter[0]).toBe(0);
      }
      expect(counter[0]).toBe(1);
    });

    it('should throw AbortError if timeout', async () => {
      expect.assertions(1);
      const semaphore = new AtomicSemaphore();
      try {
        await using _ = await LockGuard.acquire(semaphore, 100);
      } catch (e) {
        expect((e as Error)?.name).toBe('AbortError');
      }
    });
  });
});
