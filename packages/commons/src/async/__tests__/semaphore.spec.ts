import { beforeEach, describe, expect, it } from '@jest/globals';
import { CountingSemaphore, SharedCountingSemaphore } from '../semaphore.js';

describe(CountingSemaphore.name, () => {
  let semaphore: CountingSemaphore;

  beforeEach(() => {
    semaphore = new CountingSemaphore(2);
  });

  describe('acquire', () => {
    it('should block until permits are available', async () => {
      await semaphore.acquire();
      await semaphore.acquire();

      expect(semaphore.availablePermits).toBe(0);

      const p = semaphore.acquire();
      semaphore.release();
      semaphore.release();
      await p;

      expect(semaphore.availablePermits).toBe(1);
    });

    it('should throw an error if aborted', async () => {
      await semaphore.acquire();
      await semaphore.acquire();

      const abortController = new AbortController();
      const promise = semaphore.acquire({ signal: abortController.signal });
      abortController.abort();
      semaphore.release();
      await expect(promise).rejects.toThrow();
    });
  });

  describe('tryAcquire', () => {
    it('should return true when permits are available', () => {
      expect(semaphore.tryAcquire()).toBe(true);
    });

    it('should return true when there is 1 permit left', async () => {
      await semaphore.acquire();
      expect(semaphore.tryAcquire()).toBe(true);
    });

    it('should return false when no permit available', async () => {
      await semaphore.acquire();
      await semaphore.acquire();
      expect(semaphore.tryAcquire()).toBe(false);
    });
  });

  describe('release', () => {
    it('should increase available permits', async () => {
      await semaphore.acquire();
      await semaphore.acquire();
      expect(semaphore.tryAcquire()).toBe(false);
      semaphore.release();
      expect(semaphore.tryAcquire()).toBe(true);
    });

    it('should not increase available permits beyond total', () => {
      semaphore.release();
      expect(semaphore.tryAcquire()).toBe(true);
      expect(semaphore.tryAcquire()).toBe(true);
      expect(semaphore.tryAcquire()).toBe(false);
    });
  });
});

describe(SharedCountingSemaphore.name, () => {
  let semaphore: SharedCountingSemaphore;
  let semaphore2: SharedCountingSemaphore;

  beforeEach(() => {
    semaphore = new SharedCountingSemaphore({ permits: 2 });
    semaphore2 = new SharedCountingSemaphore(semaphore);
  });

  describe('acquire', () => {
    it('should block until permits are available', async () => {
      await semaphore.acquire();
      await semaphore.acquire();

      expect(semaphore.availablePermits).toBe(0);

      const p = semaphore2.acquire();
      semaphore.release();
      semaphore.release();
      await p;

      expect(semaphore.availablePermits).toBe(1);
    });

    it('should acquire on the correct buffer index', async () => {
      const semaphore = new SharedCountingSemaphore({
        permits: 2,
        buffer: new Int32Array(new SharedArrayBuffer(8)),
        index: 1,
      });
      semaphore.buffer[1] = 2;
      await semaphore.acquire();
      expect(semaphore.buffer[1]).toBe(1);
    });

    it('should throw an error if aborted', async () => {
      await semaphore.acquire();
      await semaphore.acquire();

      const abortController = new AbortController();
      const promise = semaphore2.acquire({ signal: abortController.signal });
      abortController.abort();
      await expect(promise).rejects.toThrow();
    });
  });

  describe('tryAcquire', () => {
    it('should return true when permits are available', () => {
      expect(semaphore.tryAcquire()).toBe(true);
    });

    it('should return true when there is 1 permit left', async () => {
      await semaphore.acquire();
      expect(semaphore2.tryAcquire()).toBe(true);
    });

    it('should return false when no permit available', async () => {
      await semaphore.acquire();
      await semaphore.acquire();
      expect(semaphore2.tryAcquire()).toBe(false);
    });

    it('should try acquire on the correct buffer index', () => {
      const semaphore = new SharedCountingSemaphore({
        permits: 2,
        buffer: new Int32Array(new SharedArrayBuffer(8)),
        index: 1,
      });
      semaphore.buffer[1] = 2;
      expect(semaphore.tryAcquire()).toBe(true);
      expect(semaphore.buffer[1]).toBe(1);
    });
  });

  describe('release', () => {
    it('should increase available permits', async () => {
      await semaphore.acquire();
      await semaphore.acquire();
      expect(semaphore2.tryAcquire()).toBe(false);
      semaphore.release();
      expect(semaphore2.tryAcquire()).toBe(true);
    });

    it('should not increase available permits beyond total', () => {
      semaphore.release();
      expect(semaphore.tryAcquire()).toBe(true);
      expect(semaphore.tryAcquire()).toBe(true);
      expect(semaphore.tryAcquire()).toBe(false);
    });

    it('should release on the correct buffer index', async () => {
      const semaphore = new SharedCountingSemaphore({
        permits: 2,
        buffer: new Int32Array(new SharedArrayBuffer(8)),
        index: 1,
      });
      semaphore.buffer[1] = 2;

      await semaphore.acquire();
      await semaphore.acquire();
      expect(semaphore.tryAcquire()).toBe(false);
      semaphore.release();
      expect(semaphore.tryAcquire()).toBe(true);
    });
  });
});
