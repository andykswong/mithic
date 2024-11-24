import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { symbolCabiLower } from '@mithic/commons';
import { wallClock } from './index.ts';

describe('wall-clock', () => {
  describe('resolution', () => {
    it('should return 1ms in sec and ns', () => {
      assert.deepStrictEqual(wallClock.resolution(), { seconds: 0n, nanoseconds: 1e6 });
    });

    describe('cabiLower', () => {
      it('should set 1ms in sec and ns to return pointer', () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const view = new DataView(memory.buffer);
        const resolution = wallClock.resolution[symbolCabiLower]!({ memory, realloc: () => 0, resourceTables: [] });

        resolution(8);

        assert.strictEqual(view.getBigUint64(8, true), 0n);
        assert.strictEqual(view.getUint32(16, true), 1e6);
      });
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


    describe('cabiLower', () => {
      it('should set Date.now() in sec and ns to return pointer', () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const view = new DataView(memory.buffer);
        const now = wallClock.now[symbolCabiLower]!({ memory, realloc: () => 0, resourceTables: [] });

        now(16);

        assert.strictEqual(view.getBigUint64(16, true), EPOCH_SEC);
        assert.strictEqual(view.getUint32(24, true), EPOCH_NS);
      });
    });
  });
});
