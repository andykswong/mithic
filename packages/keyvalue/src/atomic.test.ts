import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { dispose } from '@mithic/commons';
import { runWorker } from './test/worker.ts';
import { KeyValue } from './index.ts';
import { compareAndSwap, increment } from './atomic.ts';
import { type Bucket, open } from './store.ts';

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
      assert.deepStrictEqual(increment(bucket, KEY, 3n), 5n);
    });
  });

  describe('compareAndSwap', () => {
    it('should perform compare-and-swap for given key', () => {
      bucket.set(KEY, VALUE);
      const newValue = new Uint8Array([3]);
      assert.strictEqual(compareAndSwap(bucket, KEY, VALUE, newValue), true)
      assert.deepStrictEqual(bucket.get(KEY), newValue);
    });
  });
});
