import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LockGuard } from './lockguard.ts';
import { AtomicSemaphore } from './semaphore.ts';
import { dispose } from '../lifecycle.ts';

describe('LockGuard', () => {
  describe('acquire', () => {
    it('should return a LockGuard', async () => {
      const counter = new Int32Array(new SharedArrayBuffer(4));
      counter[0] = 1;
      const semaphore = new AtomicSemaphore({ buffer: counter });
      const lock = await LockGuard.acquire(semaphore);
      assert.strictEqual(counter[0], 0);
      dispose(lock);
      assert.strictEqual(counter[0], 1);
    });

    it('should throw AbortError if timeout', async () => {
      setTimeout(() => {}, 100); // workaround for 'Promise resolution is still pending' error with Atomics.waitAsync
      const semaphore = new AtomicSemaphore();
      await assert.rejects(async () => {
        await LockGuard.acquire(semaphore, 10);
      }, { name: 'AbortError' });
    });
  });
});
