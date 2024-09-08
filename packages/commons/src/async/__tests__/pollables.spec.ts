import { Worker } from 'node:worker_threads';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { AtomicPollables } from '../pollables.ts';

const FREE_HEAD_IDX = 1;
const MIN_IDX = 3;
const MAX_SIZE = 6;

describe(AtomicPollables.name, () => {
  let data: SharedArrayBuffer;
  let state: Int32Array;
  let pollables: AtomicPollables;

  beforeEach(() => {
    data = new SharedArrayBuffer(24, { maxByteLength: MAX_SIZE * 4 + 12 });
    state = new Int32Array(data);
    pollables = new AtomicPollables(data);
  });

  it('has the correct string tag', () => {
    expect(`${new AtomicPollables()}`).toBe(`[object Pollables]`);
  });

  describe('create', () => {
    it('should allocate new pollables', () => {
      const pollable = pollables.create();
      expect(pollable).toBe(MIN_IDX);
      expect(pollables.size).toBe(1);

      const pollable2 = pollables.create();
      expect(pollable2).toBe(MIN_IDX + 1);
      expect(pollables.size).toBe(2);
    });

    it('should grow the underlying buffer as needed', () => {
      for (let i = 0; i < 4; i++) { pollables.create(); }
      expect(data.byteLength).toBe(data.maxByteLength);
    });

    it('should return 0 if max size reached', () => {
      for (let i = 0; i < MAX_SIZE; i++) { pollables.create(); }
      expect(pollables.create()).toBe(0);
      expect(pollables.size).toBe(MAX_SIZE);
    });

    it('should reuse slots after delete', () => {
      pollables.create();
      const pollable = pollables.create();
      pollables.create();

      expect(pollables.delete(pollable)).toBe(true);
      const newPollable = pollables.create();
      expect(newPollable).toBe(pollable);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) { pollables.create(); }
    });

    it('should put deleted index into free list', () => {
      const pollable = pollables.create();
      pollables.create();
      expect(pollables.size).toBe(5);
      expect(pollables.delete(pollable)).toBe(true);
      expect(state[FREE_HEAD_IDX]).toBe(pollable);
      expect(state[pollable]).toBe(-1);
      expect(pollables.size).toBe(4);
    });

    it('should do nothing when out of range', () => {
      expect(pollables.delete(1)).toBe(false);
      expect(pollables.delete(6)).toBe(false);
    });

    it('should do nothing on deleted pollable', () => {
      const pollable = pollables.create();
      pollables.create();
      expect(pollables.delete(pollable)).toBe(true);
      expect(pollables.delete(pollable)).toBe(false);
      expect(state[pollable]).toBe(-1);
      expect(pollables.size).toBe(4);
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
      expect(pollables.state(pollable)).toBe(newState);
      expect(pollables.state(pollable2)).toBe(0);
    });

    it('should return < 0 when deleted', () => {
      const pollable = pollables.create();
      pollables.delete(pollable);
      expect(pollables.state(pollable)).toBeLessThan(0);
    });

    it('should return -1 when out of range', () => {
      expect(pollables.state(0)).toBe(-1);
    });
  });

  describe('ready', () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) { pollables.create(); }
    });

    it('should return true when ready', () => {
      const pollable = pollables.create();
      state[pollable] = 1;
      expect(pollables.ready(pollable)).toBe(true);
    });

    it('should return false when not ready', () => {
      const pollable = pollables.create();
      expect(pollables.ready(pollable)).toBe(false);
    });

    it('should return false when deleted', () => {
      const pollable = pollables.create();
      pollables.delete(pollable);
      expect(pollables.ready(pollable)).toBe(false);
    });

    it('should return false when out of range', () => {
      expect(pollables.ready(0)).toBe(false);
    });
  });

  describe('notify', () => {
    it('should set state to 1 by default and send notify signal', async () => {
      const pollable = pollables.create();
      const promise = pollables.waitAsync(pollable);
      expect(pollables.notify(pollable)).toBe(1);
      expect(await promise).toBe(true);
      expect(pollables.state(pollable)).toBe(1);
    });

    it('should set state to given value and send notify signal', async () => {
      const value = 2;
      const pollable = pollables.create();
      const promise = pollables.waitAsync(pollable);
      expect(pollables.notify(pollable, value)).toBe(1);
      expect(await promise).toBe(true);
      expect(pollables.state(pollable)).toBe(value);
    });

    it('should do nothing if state does not change', () => {
      const pollable = pollables.create();
      state[pollable] = 1;
      pollables.waitAsync(pollable);
      expect(pollables.notify(pollable)).toBe(0);
    });

    it('should do nothing on deleted pollable', () => {
      const pollable = pollables.create();
      pollables.delete(pollable);
      pollables.waitAsync(pollable);
      expect(pollables.notify(pollable)).toBe(0);
    });

    it('should do nothing when out of range', () => {
      expect(pollables.notify(1)).toBe(0);
      expect(pollables.notify(MIN_IDX)).toBe(0);
    });
  });

  describe('wait', () => {
    it('should do nothing when out of range', () => {
      expect(pollables.wait(1)).toBe(false);
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
      expect(pollables.wait(pollable)).toBe(true);
    });
  });
});
