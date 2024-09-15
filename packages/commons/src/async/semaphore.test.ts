import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AtomicSemaphore } from './semaphore.ts';

describe('AtomicSemaphore', () => {
  let semaphore: AtomicSemaphore;
  let semaphore2: AtomicSemaphore;

  beforeEach(() => {
    semaphore = new AtomicSemaphore();
    semaphore2 = new AtomicSemaphore(semaphore);
  });

  describe('waitAsync', () => {
    it('should wait until semaphore is available', async () => {
      const p = semaphore2.waitAsync();
      assert(p instanceof Promise);
      semaphore.notify(2);
      assert.strictEqual(await p, true);
      assert.strictEqual(semaphore.state, 1);
    });

    it('should return immediately if available', () => {
      semaphore.notify(3);
      assert.strictEqual(semaphore2.waitAsync(2), true);
      assert.strictEqual(semaphore.state, 1);
    });

    it('should return false if timeout', async () => {
      setTimeout(() => {}, 100); // workaround for 'Promise resolution is still pending' error with Atomics.waitAsync
      assert.strictEqual(await semaphore2.waitAsync(1, 10), false);
    });
  });

  describe('wait', () => {
    it('should return true immediately when available to be consumed', () => {
      semaphore.notify(3);
      assert.strictEqual(semaphore2.wait(), true);
      assert.strictEqual(semaphore.state, 2);
    });

    it('should consume given count', () => {
      semaphore.notify(3);
      assert.strictEqual(semaphore2.wait(2), true);
      assert.strictEqual(semaphore.state, 1);
    });

    it('should return false immediately when no permit available and timeout = 0', () => {
      assert.strictEqual(semaphore.wait(1, 0), false);
    });
  });

  describe('notify', () => {
    it('should increase the semaphore by 1 by default', () => {
      assert.strictEqual(semaphore2.wait(1, 0), false);
      semaphore.notify();
      assert.strictEqual(semaphore.state, 1);
      assert.strictEqual(semaphore2.wait(1, 0), true);
    });

    it('should increase the semaphore by given count and notifies waiting agent', async () => {
      const waiter = semaphore2.waitAsync(2);
      semaphore.notify(2);
      assert.strictEqual(semaphore.state, 2);
      assert.strictEqual(await waiter, true);
    });
  });
});
