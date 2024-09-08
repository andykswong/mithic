import { beforeEach, describe, expect, it } from '@jest/globals';
import { encode } from 'cbor-x/encode';
import { KeyOrder, StoreError, StoreErrorType, type KeySelector } from '../../types.ts';
import { InMemoryKeyValueStore } from '../memory.ts';

describe(InMemoryKeyValueStore.name, () => {
  const bucket = 'test';
  let store: InMemoryKeyValueStore;

  beforeEach(() => {
    store = new InMemoryKeyValueStore();
    store.open(bucket);
  });

  it('should have correct string tag', () => {
    expect(store.toString()).toBe(`[object ${InMemoryKeyValueStore.name}]`);
  });

  describe('open', () => {
    it('should init bucket and return identifier as is', () => {
      expect(store.open(bucket)).toBe(bucket);
      expect(store['buckets'].get(bucket)).toEqual(new Map());
    });
  });

  describe('close', () => {
    it('should delete bucket', () => {
      store.updateMany(bucket, [['1', new Uint8Array()]]);
      store.close(bucket);
      expect(store['buckets'].get(bucket)).toBeUndefined();
    });

    it('should delete bucket only if ref count is 0', () => {
      const key = '1', value = new Uint8Array([11]);
      store.open(bucket);
      store.updateMany(bucket, [[key, value]]);
      store.close(bucket);
      expect(store['buckets'].get(bucket)?.get(key)).toEqual(value);
    });
  });

  describe('getMany', () => {
    it('should get data from store', () => {
      const key1 = '123', key2 = '4';
      const value1 = new Uint8Array([1, 2, 3]), value2 = 456n;
      store['buckets'].get(bucket)?.set(key1, value1);
      store['buckets'].get(bucket)?.set(key2, value2);

      expect(store.getMany(bucket, [key1, 'unknown', key2])).toEqual([value1, null, encode(value2)]);
    });

    it('throws if trying to get a non-opened store', () => {
      expect(() => store.getMany('unknown', ['key'])).toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('exists', () => {
    it('should return true if key exists in local storage', () => {
      const key1 = '123';
      store.updateMany(bucket, [[key1, new Uint8Array()]]);
      expect(store.exists(bucket, key1)).toBe(true);
    });

    it('should return false for non-existent key', () => {
      store.updateMany(bucket, [['2', new Uint8Array()]]);
      expect(store.exists(bucket, '1')).toBe(false);
    });

    it('throw if trying to check a non-opened store', () => {
      expect(() => store.exists('unknown', 'key')).toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('updateMany', () => {
    it('should set or deleta data in local storage', () => {
      const key1 = '123', key2 = '4', key3 = '1337';
      const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]), value3 = new Uint8Array([7, 8, 9]);
      store['buckets'].get(bucket)?.set(key1, value1);
      store['buckets'].get(bucket)?.set(key2, value2);

      store.updateMany(bucket, [[key3, value3], [key1, null]]);
      expect(store.getMany(bucket, [key1, key2, key3])).toEqual([null, value2, value3]);
    });

    it('throw if trying to update a non-opened store', () => {
      expect(() => store.updateMany('unknown', [['123', new Uint8Array([1])]]))
        .toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('increment', () => {
    it('should increment stored number', () => {
      const key = 'counter';
      store['buckets'].get(bucket)?.set(key, 0xefn);
      expect(store.increment(bucket, key, 123n)).toBe(0x16an);
    });

    it('throw if trying to update a non-opened store', () => {
      expect(() => store.increment('unknown', 'key', 1n))
        .toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('compareAndSwap', () => {
    it('should replace stored value if matches old value', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      const newValue = new Uint8Array([0x6a, 0x01, 0, 0]);
      store.updateMany(bucket, [[key, value]]);

      expect(store.compareAndSwap(bucket, key, value, newValue)).toBe(true);
      expect(store.getMany(bucket, [key])).toEqual([newValue]);
    });

    it('should set value if old value is undefined', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);

      expect(store.compareAndSwap(bucket, key, undefined, value)).toBe(true);
      expect(store.getMany(bucket, [key])).toEqual([value]);
    });

    it('should delete stored value if matches old value and new value is undefined', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      store.updateMany(bucket, [[key, value]]);

      expect(store.compareAndSwap(bucket, key, value, undefined)).toBe(true);
      expect(store.exists(bucket, key)).toBe(false);
    });

    it('should return false if stored value does not match old value', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      store.updateMany(bucket, [[key, value]]);

      expect(store.compareAndSwap(bucket, key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0]))).toBe(false);
      expect(store.getMany(bucket, [key])).toEqual([value]);
    });
  
    it('throw if trying to update a non-opened store', () => {
      expect(() => store.compareAndSwap('unknown', 'key', new Uint8Array([1]), undefined))
        .toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
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
      expect(store.listKeys(bucket)).toEqual({ keys: [key1, key3, key2] });
    });

    it.each([
      [{} as KeySelector, [key1, key3, key2]],
      [{ order: KeyOrder.Asc }, [key1, key2, key3]],
      [{ order: KeyOrder.Desc }, [key3, key2, key1]],
      [{ start: key2, order: KeyOrder.Asc }, [key2, key3]],
      [{ end: key2, order: KeyOrder.Asc }, [key1]],
      [{ end: key3, order: KeyOrder.Desc }, [key2, key1]],
      [{ start: key2, end: key3 }, [key2]],
      [{ start: key2, end: key2, order: KeyOrder.Asc }, []],
    ])('should return filtered keys in correct order', (selector: KeySelector, expectedKeys: string[]) => {
      expect(store.listKeys(bucket, selector)).toEqual({ keys: expectedKeys });
    });
  });
});
