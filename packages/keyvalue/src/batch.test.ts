import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { dispose } from '@mithic/commons';
import { runWorker } from './test/worker.ts';
import { KeyValue } from './index.ts';
import { deleteMany, getMany, setMany } from './batch.ts';
import { type Bucket, open } from './store.ts';

describe('batch', () => {
  const bucketId = 'bucket';
  const key1 = '1', key2 = '2', key3 = '3';
  const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);

  let bucket: Bucket;
  let worker: Worker;

  beforeEach(async () => {
    [worker, KeyValue.provider] = runWorker();
    bucket = open(bucketId);
    bucket.set(key1, value1);
    bucket.set(key2, value2);
    bucket.set(key3, value3);
  });

  afterEach(async () => {
    dispose(bucket);
    await worker?.terminate();
  });

  describe('getMany', () => {
    it('should return values from bucket', () => {
      const key = 'keyyy';
      assert.deepStrictEqual(getMany(bucket, [key, key2, key3]), [undefined, [key2, value2], [key3, value3]]);
    });
  });

  describe('setMany', () => {
    it('should set key values to bucket', () => {
      const key = '4', value = new Uint8Array([4]), newValue2 = new Uint8Array([22]);
      setMany(bucket, [[key2, newValue2], [key, value]]);
      assert.deepStrictEqual(getMany(bucket, [key, key1, key2, key3]), [[key, value], [key1, value1], [key2, newValue2], [key3, value3]]);
    });
  });

  describe('deleteMany', () => {
    it('should delete keys from bucket', () => {
      deleteMany(bucket, ['keyyy', key2, key1]);
      assert.deepStrictEqual(getMany(bucket, [key1, key2, key3]), [undefined, undefined, [key3, value3]]);
    });
  });
});
