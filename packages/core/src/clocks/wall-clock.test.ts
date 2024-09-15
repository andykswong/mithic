import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { wallClock } from './index.ts';

describe('wall-clock', () => {
  describe('resolution', () => {
    it('should return 1ms', () => {
      assert.deepStrictEqual(wallClock.resolution(), { seconds: 0n, nanoseconds: 1e6 });
    });
  });

  describe('now', () => {
    const EPOCH_SEC = 1723322405n;
    const EPOCH_NS = 123_000_000;
    const TIMESTAMP = 1723322405_123;

    beforeEach(() => {
      mock.timers.enable({
        apis: ['Date'],
        now: TIMESTAMP,
      });
    });

    afterEach(() => {
      mock.timers.reset();
    });

    it('should return Date.now() in sec and ns', () => {
      assert.deepStrictEqual(wallClock.now(), { seconds: EPOCH_SEC, nanoseconds: EPOCH_NS });
    });
  });
});
