import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { dispose } from '@mithic/commons';
import { InMemoryKeyValueProvider, type InMemoryKeyValueStore, KeyValue } from './index.ts';
import { type Bucket, open } from './store.ts';

const BUCKET_ID = 'bucket';

describe('store', () => {
  let bucket: Bucket;

  beforeEach(() => {
    KeyValue.provider = new InMemoryKeyValueProvider();
    bucket = open(BUCKET_ID) as Bucket;
  });

  afterEach(() => {
    dispose(bucket);
  });

  describe('open', () => {
    it('should open correct bucket', () => {
      assert.strictEqual((bucket.store as InMemoryKeyValueStore).name, BUCKET_ID);
    });
  });

  describe('Bucket', () => {
    describe('dispose', () => {
      it('should dispose underlying store', () => {
        const mockDispose = bucket.store[Symbol.dispose] = mock.fn<() => void>();
        dispose(bucket);
        assert.strictEqual(mockDispose.mock.callCount(), 1);
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
        assert.deepStrictEqual(bucket.listKeys(), { keys: [key, key2] });
      });
    });
  });
});
