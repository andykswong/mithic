import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { dispose } from '@mithic/commons';
import { runWorker } from '#tests/worker';
import { KeyValue } from '../provider/index.ts';
import { Bucket, open } from '../store.ts';
import { StoreError, StoreErrorType } from '../types.ts';

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
      expect(bucket.bucket).toBe(bucketId);
    });
  });

  describe(Bucket.name, () => {
    beforeEach(() => {
      bucket = open(bucketId);
    });

    describe('close', () => {
      it('should close bucket', () => {
        dispose(bucket);
        expect(() => KeyValue.provider.exists(bucketId, 'key'))
          .toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
      });
    });

    describe('exists', () => {
      it('should check if key exists in bucket', () => {
        const key = 'key';
        bucket.set(key, new Uint8Array());
        expect(bucket.exists(key)).toBe(true);
      });
    });

    describe('get', () => {
      it('should return stored value from bucket', () => {
        const key = 'key', value = new Uint8Array([1, 2, 3]);
        bucket.set(key, value);
        expect(bucket.get(key)).toEqual(value);
        expect(bucket.get('keyyyyy')).toBeUndefined();
      });
    });

    describe('delete', () => {
      it('should delete value from bucket', () => {
        const key = 'key', value = new Uint8Array([1, 2, 3]);
        bucket.set(key, value);
        expect(bucket.get(key)).toEqual(value);
        bucket.delete(key);
        expect(bucket.get(key)).toBeUndefined();
      });
    });

    describe('listKeys', () => {
      it('should return keys from bucket', () => {
        const key = 'key', value = new Uint8Array([1, 2, 3]);
        const key2 = 'key2', value2 = new Uint8Array([4, 5]);
        bucket.set(key, value);
        bucket.set(key2, value2);

        expect(bucket.listKeys()).toEqual({ keys: [key, key2] });
      });
    });
  });
});
