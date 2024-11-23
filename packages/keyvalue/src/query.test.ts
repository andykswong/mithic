import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dispose } from '@mithic/commons';
import { InMemoryKeyValueProvider, KeyOrder, KeyValue } from './index.ts';
import { listKeys } from './query.ts';
import { type Bucket, open } from './store.ts';

const BUCKET_ID = 'bucket';

describe('query', () => {
  let bucket: Bucket;

  beforeEach(() => {
    KeyValue.provider = new InMemoryKeyValueProvider();
    bucket = open(BUCKET_ID) as Bucket;
  });

  afterEach(() => {
    dispose(bucket);
  });

  describe('listKeys', () => {
    it('should return keys from bucket', () => {
      const key1 = '1', key2 = '2', key3 = '3';
      const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);
      bucket.set(key1, value1);
      bucket.set(key2, value2);
      bucket.set(key3, value3);

      assert.deepStrictEqual(listKeys(bucket, { end: key3, order: KeyOrder.Desc }, ), { keys: [key2, key1] });
    });
  });
});
