import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';
import type { Pollable } from '../io/poll.ts';
import { monotonicClock } from './index.ts';
import { dispose } from '@mithic/commons';

describe('monotonic-clock', () => {
  const NOW_MS = 1234.5678;
  const NOW_NS = 1234567800n;
  let pollable: Pollable | undefined;
  let nowMock: Mock<typeof performance.now>;
  let now: number;

  beforeEach(() => {
    now = 0;
    nowMock = mock.method(performance, 'now');
    nowMock.mock.mockImplementation(() => now);
    pollable = undefined;
  });

  afterEach(async () => {
    mock.restoreAll();
    dispose(pollable);
  });

  describe('resolution', () => {
    it('should return 100 microseconds', () => {
      assert.deepStrictEqual(monotonicClock.resolution(), 100_000n);
    });
  });

  describe('now', () => {
    it('should return Date.now() in sec and ns', () => {
      now = NOW_MS;
      assert.deepStrictEqual(monotonicClock.now(), NOW_NS);
    });
  });

  describe('subscribeInstant', () => {
    it('should return a Pollable that resolves after the specified instant', async () => {
      pollable = monotonicClock.subscribeInstant(NOW_NS);
      assert.strictEqual(pollable.ready(), false);
      now = NOW_MS;
      await pollable;
      assert.strictEqual(pollable.ready(), true);
    });

    it('should return a Pollable that is ready after the specified instant without wait', async () => {
      pollable = monotonicClock.subscribeInstant(NOW_NS);
      assert.strictEqual(pollable.ready(), false);
      now = NOW_MS;
      assert.strictEqual(pollable.ready(), true);
    });
  });

  describe('subscribeDuration', () => {
    it('should return a Pollable that resolves after the specified duration', async () => {
      now = 135.7;
      pollable = monotonicClock.subscribeDuration(NOW_NS);
      assert.strictEqual(pollable.ready(), false);
      now += NOW_MS;
      await pollable;
      assert.strictEqual(pollable.ready(), true);
    });

    it('should return a Pollable that can block for specified duration', async () => {
      mock.restoreAll();
      const start = performance.now();
      pollable = monotonicClock.subscribeDuration(10_000_000n);
      pollable.block();
      assert(performance.now() - start >= 10);
      assert.strictEqual(pollable.ready(), true);
    });

    it('should return a Pollable that resolves for 0 duration', async () => {
      pollable = monotonicClock.subscribeDuration(0n);
      await pollable;
      assert.strictEqual(pollable.ready(), true);
    });

    it('should return a Pollable that can synchronously resolve immediately for 0 duration', async () => {
      pollable = monotonicClock.subscribeDuration(0n);
      pollable.block();
      assert.strictEqual(pollable.ready(), true);
    });
  });
});
