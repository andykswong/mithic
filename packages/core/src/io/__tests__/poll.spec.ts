import { Worker } from 'node:worker_threads';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { AtomicPollables } from '@mithic/commons';
import { Pollable, poll } from '../poll.ts';
import { Io } from '../types.ts';

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

  describe(Pollable.name, () => {
    describe('constructor', () => {
      it('should create new Pollable of given ID', () => {
        const id = 1;
        expect(new Pollable({ id, pollables }).id).toBe(id);
      });
    });

    describe('ready', () => {
      it('should return true when ready', () => {
        using pollable = new Pollable({ pollables });
        pollables.notify(pollable.id);
        expect(pollable.ready()).toBe(true);
      });
    });

    describe('block', () => {
      it('should wait for itself to be ready', () => {
        using pollable = new Pollable({ pollables });
        new Worker(WORKER_CODE, {
          eval: true,
          workerData: { state, pollable: pollable.id }
        });
        pollable.block();
        expect(pollable.ready()).toBe(true);
      });

      it('should return true immediately if already ready', () => {
        using pollable = new Pollable({ pollables });
        pollables.notify(pollable.id);
        pollable.block();
      });
    });

    describe('waitAsync', () => {
      it('should async wait for itself to be ready', async () => {
        using pollable = new Pollable({ pollables });
        const promise = pollable.waitAsync();
        pollables.notify(pollable.id);
        await promise;
      });
    });

    describe('dispose', () => {
      it('should delete pollable on dispose', () => {
        pollables.create();
        {
          using _ = new Pollable({ pollables });
          expect(pollables.size).toBe(2);
        }
        expect(pollables.size).toBe(1);
      });
    });
  });

  describe(poll.name, () => {
    beforeEach(() => {
      Io.pollables = pollables;
    });

    it('should poll all pollables', () => {
      const pollableList = [new Pollable({ pollables }), new Pollable({ pollables }), new Pollable({ pollables })];
      new Worker(WORKER_CODE, {
        eval: true,
        workerData: { state, pollable: pollableList[1].id }
      });
      expect(poll(pollableList)).toStrictEqual([1]);
      expect(pollableList[1].ready()).toBe(true);
    });

    it('should not block if some pollable is already ready', () => {
      const pollableList = [new Pollable({ pollables }), new Pollable({ pollables })];
      pollables.notify(pollableList[1].id);
      expect(poll(pollableList)).toStrictEqual([1]);
    });
  });
});
