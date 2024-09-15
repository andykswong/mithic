import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { encode } from 'cbor-x/encode';
import { KeyOrder, StoreError, StoreErrorType } from '../types.ts';
import { InMemoryKeyValueStore } from './index.ts';

describe('InMemoryKeyValueStore', () => {
  const bucket = 'test';
  let store: InMemoryKeyValueStore;

  beforeEach(() => {
    store = new InMemoryKeyValueStore();
    store.open(bucket);
  });

  it('should have correct string tag', () => {
    assert.strictEqual(store.toString(), `[object ${InMemoryKeyValueStore.name}]`);
  });

  describe('open', () => {
    it('should init bucket and return identifier as is', () => {
      assert.strictEqual(store.open(bucket), bucket);
      assert.deepStrictEqual(store['buckets'].get(bucket), new Map());
    });
  });

  describe('close', () => {
    it('should delete bucket', () => {
      store.updateMany(bucket, [['1', new Uint8Array()]]);
      store.close(bucket);
      assert.strictEqual(store['buckets'].get(bucket), undefined);
    });

    it('should delete bucket only if ref count is 0', () => {
      const key = '1', value = new Uint8Array([11]);
      store.open(bucket);
      store.updateMany(bucket, [[key, value]]);
      store.close(bucket);
      assert.deepStrictEqual(store['buckets'].get(bucket)?.get(key), value);
    });
  });

  describe('getMany', () => {
    it('should get data from store', () => {
      const key1 = '123', key2 = '4';
      const value1 = new Uint8Array([1, 2, 3]), value2 = 456n;
      store['buckets'].get(bucket)?.set(key1, value1);
      store['buckets'].get(bucket)?.set(key2, value2);

      assert.deepStrictEqual(store.getMany(bucket, [key1, 'unknown', key2]), [value1, null, encode(value2)]);
    });

    it('throws if trying to get a non-opened store', () => {
      assert.throws(() => store.getMany('unknown', ['key']), new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('exists', () => {
    it('should return true if key exists in local storage', () => {
      const key1 = '123';
      store.updateMany(bucket, [[key1, new Uint8Array()]]);
      assert.strictEqual(store.exists(bucket, key1), true);
    });

    it('should return false for non-existent key', () => {
      store.updateMany(bucket, [['2', new Uint8Array()]]);
      assert.strictEqual(store.exists(bucket, '1'), false);
    });

    it('throw if trying to check a non-opened store', () => {
      assert.throws(() => store.exists('unknown', 'key'), new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('updateMany', () => {
    it('should set or deleta data in local storage', () => {
      const key1 = '123', key2 = '4', key3 = '1337';
      const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]), value3 = new Uint8Array([7, 8, 9]);
      store['buckets'].get(bucket)?.set(key1, value1);
      store['buckets'].get(bucket)?.set(key2, value2);

      store.updateMany(bucket, [[key3, value3], [key1, null]]);
      assert.deepStrictEqual(store.getMany(bucket, [key1, key2, key3]), [null, value2, value3]);
    });

    it('throw if trying to update a non-opened store', () => {
      assert.throws(
        () => store.updateMany('unknown', [['123', new Uint8Array([1])]]),
        new StoreError({ tag: StoreErrorType.NoSuchStore })
      );
    });
  });

  describe('increment', () => {
    it('should increment stored number', () => {
      const key = 'counter';
      store['buckets'].get(bucket)?.set(key, 0xefn);
      assert.strictEqual(store.increment(bucket, key, 123n), 0x16an);
    });

    it('throw if trying to update a non-opened store', () => {
      assert.throws(() => store.increment('unknown', 'key', 1n), new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('compareAndSwap', () => {
    it('should replace stored value if matches old value', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      const newValue = new Uint8Array([0x6a, 0x01, 0, 0]);
      store.updateMany(bucket, [[key, value]]);

      assert.strictEqual(store.compareAndSwap(bucket, key, value, newValue), true);
      assert.deepStrictEqual(store.getMany(bucket, [key]), [newValue]);
    });

    it('should set value if old value is undefined', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);

      assert.strictEqual(store.compareAndSwap(bucket, key, undefined, value), true);
      assert.deepStrictEqual(store.getMany(bucket, [key]), [value]);
    });

    it('should delete stored value if matches old value and new value is undefined', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      store.updateMany(bucket, [[key, value]]);

      assert.strictEqual(store.compareAndSwap(bucket, key, value, undefined), true);
      assert.strictEqual(store.exists(bucket, key), false);
    });

    it('should return false if stored value does not match old value', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      store.updateMany(bucket, [[key, value]]);

      assert.strictEqual(store.compareAndSwap(bucket, key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0])), false);
      assert.deepStrictEqual(store.getMany(bucket, [key]), [value]);
    });

    it('throw if trying to update a non-opened store', () => {
      assert.throws(
        () => store.compareAndSwap('unknown', 'key', new Uint8Array([1]), undefined),
        new StoreError({ tag: StoreErrorType.NoSuchStore })
      );
    });
  });


  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';
    const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);

    beforeEach(() => {
      store.updateMany(bucket, [[key1, value1], [key3, value3], [key2, value2]]);
      const bucket2 = store.open('test2');
      store.updateMany(bucket2, [['4', new Uint8Array([4])]]);
    });

    it('should return all keys by default', () => {
      assert.deepStrictEqual(store.listKeys(bucket), { keys: [key1, key3, key2] });
    });

    for (const [selector, expectedKeys] of [
      [{}, [key1, key3, key2]],
      [{ order: KeyOrder.Asc }, [key1, key2, key3]],
      [{ order: KeyOrder.Desc }, [key3, key2, key1]],
      [{ start: key2, order: KeyOrder.Asc }, [key2, key3]],
      [{ end: key2, order: KeyOrder.Asc }, [key1]],
      [{ end: key3, order: KeyOrder.Desc }, [key2, key1]],
      [{ start: key2, end: key3 }, [key2]],
      [{ start: key2, end: key2, order: KeyOrder.Asc }, []],
    ] as const) {
      it('should return filtered keys in correct order', () => {
        assert.deepStrictEqual(store.listKeys(bucket, selector), { keys: expectedKeys });
      });
    }
  });
});
