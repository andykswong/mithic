import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { now, resolution, subscribeDuration, subscribeInstant } from '../monotonic-clock.ts';

describe('monotonic-clock', () => {
  const NOW_MS = 1234.5678;
  const NOW_NS = 1234567800n;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  describe('resolution', () => {
    it('should return 100 microseconds', () => {
      expect(resolution()).toStrictEqual(100_000n);
    });
  });

  describe('now', () => {
    it('should return Date.now() in sec and ns', () => {
      jest.advanceTimersByTime(NOW_MS);
      expect(now()).toStrictEqual(NOW_NS);
    });
  });

  describe('subscribeInstant', () => {
    it('should return a Pollable that resolves after the specified instant', async () => {
      using pollable = subscribeInstant(NOW_NS);
      expect(pollable.ready()).toBe(false);
      jest.advanceTimersByTime(NOW_MS);
      await pollable.waitAsync();
      expect(pollable.ready()).toBe(true);
    });

    it('should return a Pollable that is ready after the specified instant without wait', async () => {
      using pollable = subscribeInstant(NOW_NS);
      expect(pollable.ready()).toBe(false);
      jest.advanceTimersByTime(NOW_MS);
      expect(pollable.ready()).toBe(true);
    });
  });

  describe('subscribeDuration', () => {
    it('should return a Pollable that resolves after the specified duration', async () => {
      jest.advanceTimersByTime(135.7);
      using pollable = subscribeDuration(NOW_NS);
      expect(pollable.ready()).toBe(false);
      jest.advanceTimersByTime(NOW_MS);
      await pollable.waitAsync();
      expect(pollable.ready()).toBe(true);
    });

    it('should return a Pollable that can block for specified duration', async () => {
      jest.useRealTimers();
      const start = performance.now();
      using pollable = subscribeDuration(10_000_000n);
      pollable.block();
      expect(performance.now() - start).toBeGreaterThanOrEqual(10);
      expect(pollable.ready()).toBe(true);
    });

    it('should return a Pollable that resolves for 0 duration', async () => {
      using pollable = subscribeDuration(0n);
      await pollable.waitAsync();
      expect(pollable.ready()).toBe(true);
    });

    it('should return a Pollable that can synchronously resolve immediately for 0 duration', async () => {
      using pollable = subscribeDuration(0n);
      pollable.block();
      expect(pollable.ready()).toBe(true);
    });
  });
});
