import { beforeEach, describe, expect, it } from '@jest/globals';
import { AtomicSemaphore } from '../semaphore.ts';

describe(AtomicSemaphore.name, () => {
  let semaphore: AtomicSemaphore;
  let semaphore2: AtomicSemaphore;

  beforeEach(() => {
    semaphore = new AtomicSemaphore();
    semaphore2 = new AtomicSemaphore(semaphore);
  });

  describe('waitAsync', () => {
    it('should wait until semaphore is available', async () => {
      const p = semaphore2.waitAsync();
      expect(p).toBeInstanceOf(Promise);
      semaphore.notify(2);
      expect(await p).toBe(true);
      expect(semaphore.state).toBe(1);
    });

    it('should return immediately if available', () => {
      semaphore.notify(3);
      expect(semaphore2.waitAsync(2)).toBe(true);
      expect(semaphore.state).toBe(1);
    });
  });

  describe('wait', () => {
    it('should return true immediately when available to be consumed', () => {
      semaphore.notify(3);
      expect(semaphore2.wait()).toBe(true);
      expect(semaphore.state).toBe(2);
    });

    it('should consume given count', () => {
      semaphore.notify(3);
      expect(semaphore2.wait(2)).toBe(true);
      expect(semaphore.state).toBe(1);
    });

    it('should return false immediately when no permit available and timeout = 0', () => {
      expect(semaphore.wait(1, 0)).toBe(false);
    });
  });

  describe('notify', () => {
    it('should increase the semaphore by 1 by default', () => {
      expect(semaphore2.wait(1, 0)).toBe(false);
      semaphore.notify();
      expect(semaphore.state).toBe(1);
      expect(semaphore2.wait(1, 0)).toBe(true);
    });

    it('should increase the semaphore by given count and notifies waiting agent', async () => {
      const waiter = semaphore2.waitAsync(2);
      semaphore.notify(2);
      expect(semaphore.state).toBe(2);
      expect(await waiter).toBe(true);
    });
  });
});
