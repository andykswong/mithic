import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { locks } from 'web-locks';
import { WebLock } from '../web-lock.ts';
import { flushPromises } from '../../__tests__/utils.ts';

describe(WebLock.name, () => {
  let lock: WebLock;
  let sharedLock: WebLock;

  beforeEach(() => {
    lock = new WebLock({ locks });
    sharedLock = new WebLock({ locks, shared: true });
  });

  afterEach(() => {
    lock.release();
    sharedLock['count'] = 1;
    sharedLock.release();
  });

  describe('acquire', () => {
    it('should block until lock is available', async () => {
      await lock.acquire();

      setTimeout(() => {
        lock.release();
      }, 500);

      await sharedLock.acquire();
    });

    it('should support multiple readers when shared = true', async () => {
      await sharedLock.acquire();
      await sharedLock.acquire();
      expect(sharedLock['count']).toBe(2);
    });

    /** TODO: abort signal does not work properly in web-locks polyfill. */
    it.skip('should throw an error if aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();
      const promise = lock.acquire({ signal: abortController.signal });
      await expect(promise).rejects.toThrow();
    });
  });

  describe('tryAcquire', () => {
    it('should return true when lock is available', async () => {
      expect(await lock.tryAcquire()).toBe(true);
    });

    it('should support multiple readers when shared = true', async () => {
      expect(await sharedLock.tryAcquire()).toBe(true);
      expect(await sharedLock.tryAcquire()).toBe(true);
      expect(sharedLock['count']).toBe(2);
    });

    /** TODO: web-locks polyfill does not currently support ifAvailable option. */
    it.skip('should return false when lock is not available', async () => {
      await lock.acquire();
      expect(await sharedLock.tryAcquire()).toBe(false);
    });
  });

  describe('release', () => {
    it('should release lock', async () => {
      await lock.acquire();
      lock.release();
      await flushPromises();
      await lock.acquire();
    });

    it('should release shared lock', async () => {
      await sharedLock.acquire();
      await sharedLock.acquire();

      const releaseSpy = jest.spyOn(sharedLock as WebLock & { resolve: () => void; }, 'resolve');

      sharedLock.release();
      expect(sharedLock['count']).toBe(1);
      expect(releaseSpy).not.toHaveBeenCalled();
      sharedLock.release();
      expect(sharedLock['count']).toBe(0);
      expect(releaseSpy).toHaveBeenCalled();
    });

    it('should do nothing if lock is not held', () => {
      lock.release();
    });
  });
});
