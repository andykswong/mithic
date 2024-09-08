import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { dispose } from '@mithic/commons';
import { runWorker } from '#tests/worker';
import { compareAndSwap, increment } from '../atomic.ts';
import { KeyValue } from '../provider/index.ts';
import { type Bucket, open } from '../store.ts';

const BUCKET_ID = 'bucket';
const KEY = 'key';
const VALUE = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]);
const COUNTER = 2n;

describe('query', () => {
  let bucket: Bucket;
  let worker: Worker;

  beforeEach(async () => {
    [worker, KeyValue.provider] = runWorker();
    bucket = open(BUCKET_ID);
  });

  afterEach(async () => {
    dispose(bucket);
    await worker?.terminate();
  });

  describe('increment', () => {
    it('should increment given key value', () => {
      KeyValue.provider.increment(BUCKET_ID, KEY, COUNTER);
      expect(increment(bucket, KEY, 3n)).toEqual(5n);
    });
  });

  describe('compareAndSwap', () => {
    it('should perform compare-and-swap for given key', () => {
      bucket.set(KEY, VALUE);
      const newValue = new Uint8Array([3]);
      expect(compareAndSwap(bucket, KEY, VALUE, newValue)).toBe(true)
      expect(bucket.get(KEY)).toEqual(newValue);
    });
  });
});
