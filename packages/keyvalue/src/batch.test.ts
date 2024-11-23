import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dispose } from '@mithic/commons';
import { InMemoryKeyValueProvider, KeyValue } from './index.ts';
import { deleteMany, getMany, setMany } from './batch.ts';
import { type Bucket, open } from './store.ts';

const BUCKET_ID = 'bucket';
const KEY1 = '1', KEY2 = '2', KEY3 = '3';
const VAL1 = new Uint8Array([1]), VAL2 = new Uint8Array([2]), VAL3 = new Uint8Array([3]);

describe('batch', () => {
  let bucket: Bucket;

  beforeEach(() => {
    KeyValue.provider = new InMemoryKeyValueProvider();
    bucket = open(BUCKET_ID) as Bucket;
    bucket.set(KEY1, VAL1);
    bucket.set(KEY2, VAL2);
    bucket.set(KEY3, VAL3);
  });

  afterEach(() => {
    dispose(bucket);
  });

  describe('getMany', () => {
    it('should return values from bucket', () => {
      const key = 'keyyy';
      assert.deepStrictEqual(getMany(bucket, [key, KEY2, KEY3]), [undefined, [KEY2, VAL2], [KEY3, VAL3]]);
    });
  });

  describe('setMany', () => {
    it('should set key values to bucket', () => {
      const key = '4', value = new Uint8Array([4]), newValue2 = new Uint8Array([22]);
      setMany(bucket, [[KEY2, newValue2], [key, value]]);
      assert.deepStrictEqual(getMany(bucket, [key, KEY1, KEY2, KEY3]), [[key, value], [KEY1, VAL1], [KEY2, newValue2], [KEY3, VAL3]]);
    });
  });

  describe('deleteMany', () => {
    it('should delete keys from bucket', () => {
      deleteMany(bucket, ['keyyy', KEY2, KEY1]);
      assert.deepStrictEqual(getMany(bucket, [KEY1, KEY2, KEY3]), [undefined, undefined, [KEY3, VAL3]]);
    });
  });
});
