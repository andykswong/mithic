import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { now, resolution } from '../wall-clock.ts';

describe('wall-clock', () => {
  describe('resolution', () => {
    it('should return 1ms', () => {
      expect(resolution()).toStrictEqual({ seconds: 0n, nanoseconds: 1e6 });
    });
  });

  describe('now', () => {
    const EPOCH_SEC = 1723322405n;
    const EPOCH_NS = 123_000_000;
    const TIMESTAMP = 1723322405_123;

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return Date.now() in sec and ns', () => {
      jest.setSystemTime(TIMESTAMP);
      expect(now()).toStrictEqual({ seconds: EPOCH_SEC, nanoseconds: EPOCH_NS });
    });
  });
});
