import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AtomicPollables, dispose } from '@mithic/commons';
import { Io, poll } from './index.ts';

const WORKER_CODE = `
  const { workerData } = require('node:worker_threads');
  setTimeout(() => {
    Atomics.store(workerData.state, workerData.pollable, 1);
    Atomics.notify(workerData.state, workerData.pollable);
  }, 200);
`;

describe('poll', () => {
  let state: Int32Array;
  let pollables: AtomicPollables;

  beforeEach(() => {
    const buffer = new SharedArrayBuffer(36);
    state = new Int32Array(buffer);
    pollables = new AtomicPollables(buffer);
  });

  describe('Pollable', () => {
    describe('constructor', () => {
      it('should create new Pollable of given ID', () => {
        const id = 1;
        assert.strictEqual(new poll.Pollable({ id, pollables }).id, id);
      });
    });

    describe('ready', () => {
      it('should return true when ready', () => {
        const pollable = new poll.Pollable({ pollables });
        pollables.notify(pollable.id);
        assert.strictEqual(pollable.ready(), true);
      });

      it('should update ready state by polling pollReady function', () => {
        let state = false;
        const pollable = new poll.Pollable({ pollables, pollReady: () => state });
        assert.strictEqual(pollable.ready(), false);
        state = true;
        assert.strictEqual(pollable.ready(), true);
        state = false;
        assert.strictEqual(pollable.ready(), false);
      });
    });

    describe('block', () => {
      it('should wait for itself to be ready', () => {
        const pollable = new poll.Pollable({ pollables });
        new Worker(WORKER_CODE, {
          eval: true,
          workerData: { state, pollable: pollable.id }
        });
        pollable.block();
        assert.strictEqual(pollable.ready(), true);
      });

      it('should return true immediately if already ready', () => {
        const pollable = new poll.Pollable({ pollables });
        pollables.notify(pollable.id);
        pollable.block();
      });
    });

    describe('then', () => {
      it('should async wait for itself to be ready', async () => {
        const pollable = new poll.Pollable({ pollables });
        pollables.notify(pollable.id);
        await pollable;
      });
    });

    describe('waitAsync', () => {
      it('should async wait for itself to be ready', async () => {
        const pollable = new poll.Pollable({ pollables });
        const promise = pollable.waitAsync();
        pollables.notify(pollable.id);
        await promise;
      });
    });

    describe('dispose', () => {
      it('should delete pollable on dispose', () => {
        pollables.create();
        const pollable = new poll.Pollable({ pollables });
        assert.strictEqual(pollables.size, 2);
        dispose(pollable);
        assert.strictEqual(pollables.size, 1);
      });
    });
  });

  describe('poll', () => {
    beforeEach(() => {
      Io.pollables = pollables;
    });

    it('should poll all pollables', () => {
      const pollableList = [new poll.Pollable({ pollables }), new poll.Pollable({ pollables }), new poll.Pollable({ pollables })];
      new Worker(WORKER_CODE, {
        eval: true,
        workerData: { state, pollable: pollableList[1].id }
      });
      assert.deepStrictEqual(poll.poll(pollableList), [1]);
      assert.strictEqual(pollableList[1].ready(), true);
    });

    it('should not block if some pollable is already ready', () => {
      const pollableList = [new poll.Pollable({ pollables }), new poll.Pollable({ pollables })];
      pollables.notify(pollableList[1].id);
      assert.deepStrictEqual(poll.poll(pollableList), [1]);
    });
  });
});
