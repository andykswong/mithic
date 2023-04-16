import { CountingSemaphore } from '../semaphore.js';

describe(CountingSemaphore.name, () => {
  let semaphore: CountingSemaphore;

  beforeEach(() => {
    semaphore = new CountingSemaphore(2);
  });

  test('acquire with available permits should succeed', async () => {
    expect.assertions(1);

    await semaphore.acquire();
    expect(semaphore.tryAcquire()).toBe(true);
  });

  test('acquire with no available permits should block', async () => {
    expect.assertions(2);

    semaphore.acquire();
    semaphore.acquire();

    setTimeout(() => {
      expect(semaphore.tryAcquire()).toBe(false);
      semaphore.release();
      semaphore.release();
    }, 100);

    await semaphore.acquire();
    expect(semaphore.tryAcquire()).toBe(true);
  });

  test('release should increase available permits', async () => {
    expect.assertions(1);
    
    await semaphore.acquire();
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(true);
  });

  test('tryAcquire should return true when permits available', () => {
    expect(semaphore.tryAcquire()).toBe(true);
  });

  test('tryAcquire should return false when no permits available', () => {
    semaphore.acquire();
    semaphore.acquire();
    expect(semaphore.tryAcquire()).toBe(false);
  });

  test('release should not increase available permits beyond total', () => {
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(false);
  });

  test('aborting the acquire should throw an error', () => {
    semaphore.acquire();
    semaphore.acquire();

    const abortController = new AbortController();
    const promise = semaphore.acquire({ signal: abortController.signal });
    abortController.abort();
    expect(promise).rejects.toThrow();
  });
});
