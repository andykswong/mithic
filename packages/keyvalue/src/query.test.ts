import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { dispose } from '@mithic/commons';
import { runWorker } from './test/worker.ts';
import { KeyOrder, KeyValue } from './index.ts';
import { listKeys } from './query.ts';
import { type Bucket, open } from './store.ts';

describe('query', () => {
  const bucketId = 'bucket';

  let bucket: Bucket;
  let worker: Worker;

  beforeEach(async () => {
    [worker, KeyValue.provider] = runWorker();
    bucket = open(bucketId);
  });

  afterEach(async () => {
    dispose(bucket);
    await worker?.terminate();
  });

  describe('listKeys', () => {
    it('should return keys from bucket', () => {
      const key1 = '1', key2 = '2', key3 = '3';
      const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);
      bucket.set(key1, value1);
      bucket.set(key2, value2);
      bucket.set(key3, value3);

      assert.deepStrictEqual(listKeys(bucket, { end: key3, order: KeyOrder.Desc }, ), { cursor: undefined, keys: [key2, key1] });
    });
  });
});
