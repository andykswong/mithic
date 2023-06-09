import { RateLimiter } from '../ratelimiter.js';

describe(RateLimiter.name, () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(2, 100);
  });

  test('acquire with available permits should succeed', async () => {
    await limiter.acquire();
    expect(limiter.tryAcquire()).toBe(true);
  });

  test('acquiring permits should respect rate limit', async () => {
    const startTime = Date.now();
    await limiter.acquire();
    const startTime2 = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(99);
    await limiter.acquire();
    expect(Date.now() - startTime2).toBeGreaterThanOrEqual(99);
  });

  test('tryAcquire should return true when permits available', () => {
    expect(limiter.tryAcquire()).toBe(true);
  });

  test('tryAcquire should return false when no permits available', () => {
    limiter.acquire();
    limiter.acquire();
    expect(limiter.tryAcquire()).toBe(false);
  });

  test('release should not increase available permits', () => {
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    limiter.release();
    expect(limiter.tryAcquire()).toBe(false);
  });

  test('aborting the acquire should throw an error', async () => {
    limiter.acquire();
    limiter.acquire();

    const abortController = new AbortController();
    const promise = limiter.acquire({ signal: abortController.signal });
    abortController.abort();
    expect(promise).rejects.toThrow();
  });
});
