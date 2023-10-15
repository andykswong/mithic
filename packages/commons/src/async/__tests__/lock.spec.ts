import { beforeEach, describe, expect, it } from '@jest/globals';
import { NoOpLock } from '../lock.js';

describe(NoOpLock.name, () => {
  let lock: NoOpLock;

  beforeEach(() => {
    lock = new NoOpLock();
  });

  describe('acquire', () => {
    it('should never block', async () => {
      for (let i = 0; i < 100; i++) {
        await lock.acquire();
      }
    });
  });

  describe('tryAcquire', () => {
    it('should always return true', () => {
      for (let i = 0; i < 100; i++) {
        expect(lock.tryAcquire()).toBe(true);
      }
    });
  });

  describe('release', () => {
    it('should do nothing', async () => {
      lock.release();
    });
  });
});
