import { beforeEach, describe, expect, it } from '@jest/globals';
import { RateLimiter } from '../ratelimiter.js';

describe(RateLimiter.name, () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(2, 100);
  });

  describe('acquire', () => {
    it('should succeed when permits are available', async () => {
      expect(limiter.semaphore.availablePermits).toBe(2);
      await limiter.acquire();
      expect(limiter.semaphore.availablePermits).toBe(1);
    });

    it('should respect rate limit', async () => {
      const startTime = Date.now();
      await limiter.acquire();
      const startTime2 = Date.now();
      await limiter.acquire();
      expect(limiter.semaphore.availablePermits).toBe(0);

      await limiter.acquire();
      expect(Date.now() - startTime).toBeGreaterThanOrEqual(50);
      await limiter.acquire();
      expect(Date.now() - startTime2).toBeGreaterThanOrEqual(50);
    });

    it('should throw an error when aborted', async () => {
      await limiter.acquire();
      await limiter.acquire();

      const abortController = new AbortController();
      abortController.abort();
      const promise = limiter.acquire({ signal: abortController.signal });
      await expect(promise).rejects.toThrow();
    });
  });

  describe('tryAcquire', () => {
    it('should consume permit when available', () => {
      expect(limiter.semaphore.availablePermits).toBe(2);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.semaphore.availablePermits).toBe(1);
    });
  
    it('should return false when no permits available', () => {
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });
  });

  describe('release', () => {
    it('should not increase available permits', () => {
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      limiter.release();
      expect(limiter.tryAcquire()).toBe(false);
    });
  });
});
