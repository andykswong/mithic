import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AtomicPollables } from './pollables.ts';

const FREE_HEAD_IDX = 1;
const MIN_IDX = 3;
const MAX_SIZE = 6;

describe('AtomicPollables', () => {
  let data: SharedArrayBuffer;
  let state: Int32Array;
  let pollables: AtomicPollables;

  beforeEach(() => {
    data = new SharedArrayBuffer(24, { maxByteLength: MAX_SIZE * 4 + 12 });
    state = new Int32Array(data);
    pollables = new AtomicPollables(data);
  });

  it('has the correct string tag', () => {
    assert.strictEqual(`${new AtomicPollables()}`, `[object Pollables]`);
  });

  describe('create', () => {
    it('should allocate new pollables', () => {
      const pollable = pollables.create();
      assert.strictEqual(pollable, MIN_IDX);
      assert.strictEqual(pollables.size, 1);

      const pollable2 = pollables.create();
      assert.strictEqual(pollable2, MIN_IDX + 1);
      assert.strictEqual(pollables.size, 2);
    });

    it('should grow the underlying buffer as needed', () => {
      for (let i = 0; i < 4; i++) { pollables.create(); }
      assert.strictEqual(data.byteLength, data.maxByteLength);
    });

    it('should return 0 if max size reached', () => {
      for (let i = 0; i < MAX_SIZE; i++) { pollables.create(); }
      assert.strictEqual(pollables.create(), 0);
      assert.strictEqual(pollables.size, MAX_SIZE);
    });

    it('should reuse slots after delete', () => {
      pollables.create();
      const pollable = pollables.create();
      pollables.create();

      assert.strictEqual(pollables.delete(pollable), true);
      const newPollable = pollables.create();
      assert.strictEqual(newPollable, pollable);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) { pollables.create(); }
    });

    it('should put deleted index into free list', () => {
      const pollable = pollables.create();
      pollables.create();
      assert.strictEqual(pollables.size, 5);
      assert.strictEqual(pollables.delete(pollable), true);
      assert.strictEqual(state[FREE_HEAD_IDX], pollable);
      assert.strictEqual(state[pollable], -1);
      assert.strictEqual(pollables.size, 4);
    });

    it('should do nothing when out of range', () => {
      assert.strictEqual(pollables.delete(1), false);
      assert.strictEqual(pollables.delete(6), false);
    });

    it('should do nothing on deleted pollable', () => {
      const pollable = pollables.create();
      pollables.create();
      assert.strictEqual(pollables.delete(pollable), true);
      assert.strictEqual(pollables.delete(pollable), false);
      assert.strictEqual(state[pollable], -1);
      assert.strictEqual(pollables.size, 4);
    });
  });

  describe('state', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) { pollables.create(); }
    });

    it('should return current state', () => {
      const newState = 2;
      const pollable = pollables.create();
      const pollable2 = pollables.create();
      state[pollable] = newState;
      assert.strictEqual(pollables.state(pollable), newState);
      assert.strictEqual(pollables.state(pollable2), 0);
    });

    it('should return < 0 when deleted', () => {
      const pollable = pollables.create();
      pollables.delete(pollable);
      assert(pollables.state(pollable) < 0);
    });

    it('should return -1 when out of range', () => {
      assert.strictEqual(pollables.state(0), -1);
    });
  });

  describe('ready', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) { pollables.create(); }
    });

    it('should return true when ready', () => {
      const pollable = pollables.create();
      state[pollable] = 1;
      assert.strictEqual(pollables.ready(pollable), true);
    });

    it('should return false when not ready', () => {
      const pollable = pollables.create();
      assert.strictEqual(pollables.ready(pollable), false);
    });

    it('should return false when deleted', () => {
      const pollable = pollables.create();
      pollables.delete(pollable);
      assert.strictEqual(pollables.ready(pollable), false);
    });

    it('should return false when out of range', () => {
      assert.strictEqual(pollables.ready(0), false);
    });
  });

  describe('notify', () => {
    it('should set state to 1 by default and send notify signal', async () => {
      const pollable = pollables.create();
      const promise = pollables.waitAsync(pollable);
      assert.strictEqual(pollables.notify(pollable), 1);
      assert.strictEqual(await promise, true);
      assert.strictEqual(pollables.state(pollable), 1);
    });

    it('should set state to given value and send notify signal', async () => {
      const value = 2;
      const pollable = pollables.create();
      const promise = pollables.waitAsync(pollable);
      assert.strictEqual(pollables.notify(pollable, value), 1);
      assert.strictEqual(await promise, true);
      assert.strictEqual(pollables.state(pollable), value);
    });

    it('should do nothing if state does not change', () => {
      const pollable = pollables.create();
      state[pollable] = 1;
      pollables.waitAsync(pollable);
      assert.strictEqual(pollables.notify(pollable), 0);
    });

    it('should do nothing on deleted pollable', () => {
      const pollable = pollables.create();
      pollables.delete(pollable);
      pollables.waitAsync(pollable);
      assert.strictEqual(pollables.notify(pollable), 0);
    });

    it('should do nothing when out of range', () => {
      assert.strictEqual(pollables.notify(1), 0);
      assert.strictEqual(pollables.notify(MIN_IDX), 0);
    });
  });

  describe('wait', () => {
    it('should do nothing when out of range', () => {
      assert.strictEqual(pollables.wait(1), false);
    });

    it('should wait for pollable to be ready', () => {
      const pollable = pollables.create();
      new Worker(`
        const { workerData } = require('node:worker_threads');
        setTimeout(() => Atomics.notify(workerData.state, workerData.pollable), 200);
      `, {
        eval: true,
        workerData: { state, pollable }
      });
      assert.strictEqual(pollables.wait(pollable), true);
    });
  });
});
