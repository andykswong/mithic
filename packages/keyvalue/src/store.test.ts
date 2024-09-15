import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { dispose } from '@mithic/commons';
import { runWorker } from './test/worker.ts';
import { KeyValue, StoreError, StoreErrorType } from './index.ts';
import { type Bucket, open } from './store.ts';

describe('store', () => {
  const bucketId = 'bucket';

  let bucket: Bucket;
  let worker: Worker;

  beforeEach(async () => {
    [worker, KeyValue.provider] = runWorker();
  });

  afterEach(async () => {
    dispose(bucket);
    await worker?.terminate();
  });

  describe('open', () => {
    it('should open bucket', async () => {
      bucket = open(bucketId);
      assert.strictEqual(bucket.bucket, bucketId);
    });
  });

  describe('Bucket', () => {
    beforeEach(() => {
      bucket = open(bucketId);
    });

    describe('close', () => {
      it('should close bucket', () => {
        dispose(bucket);
        assert.throws(() => KeyValue.provider.exists(bucketId, 'key'), new StoreError({ tag: StoreErrorType.NoSuchStore }));
      });
    });

    describe('exists', () => {
      it('should check if key exists in bucket', () => {
        const key = 'key';
        bucket.set(key, new Uint8Array());
        assert.strictEqual(bucket.exists(key), true);
      });
    });

    describe('get', () => {
      it('should return stored value from bucket', () => {
        const key = 'key', value = new Uint8Array([1, 2, 3]);
        bucket.set(key, value);
        assert.deepStrictEqual(bucket.get(key), value);
        assert.strictEqual(bucket.get('keyyyyy'), undefined);
      });
    });

    describe('delete', () => {
      it('should delete value from bucket', () => {
        const key = 'key', value = new Uint8Array([1, 2, 3]);
        bucket.set(key, value);
        assert.deepStrictEqual(bucket.get(key), value);
        bucket.delete(key);
        assert.strictEqual(bucket.get(key), undefined);
      });
    });

    describe('listKeys', () => {
      it('should return keys from bucket', () => {
        const key = 'key', value = new Uint8Array([1, 2, 3]);
        const key2 = 'key2', value2 = new Uint8Array([4, 5]);
        bucket.set(key, value);
        bucket.set(key2, value2);
        assert.deepStrictEqual(bucket.listKeys(), { cursor: undefined, keys: [key, key2] });
      });
    });
  });
});
