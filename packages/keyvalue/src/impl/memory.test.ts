import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { encode } from 'cbor-x/encode';
import { KeyOrder } from '../types.ts';
import { InMemoryKeyValueProvider, InMemoryKeyValueStore } from './index.ts';

const BUCKET = 'test';

describe('InMemoryKeyValueProvider', () => {
  let provider: InMemoryKeyValueProvider;

  beforeEach(() => {
    provider = new InMemoryKeyValueProvider();
  });

  describe('open', () => {
    it('should return an InMemoryKeyValueStore', () => {
      const store = provider.open(BUCKET);
      assert.ok(store instanceof InMemoryKeyValueStore);
      assert.strictEqual(store.name, BUCKET);
      assert.strictEqual(store['intEncoder'], provider['intEncoder']);
    });

    it('should return the same instance when opening the same bucket twice', () => {
      const store = provider.open(BUCKET);
      const store2 = provider.open(BUCKET);
      assert.strictEqual(store, store2);
    });
  });
});

describe('InMemoryKeyValueStore', () => {
  let provider: InMemoryKeyValueProvider;
  let store: InMemoryKeyValueStore;

  beforeEach(() => {
    provider = new InMemoryKeyValueProvider();
    store = provider.open(BUCKET);
  });

  it('should have correct string tag', () => {
    assert.strictEqual(store.toString(), `[object ${InMemoryKeyValueStore.name}]`);
  });

  describe('getMany', () => {
    it('should get data from store', () => {
      const key1 = '123', key2 = '4';
      const value1 = new Uint8Array([1, 2, 3]), value2 = 456n;
      set(key1, value1);
      set(key2, value2);

      assert.deepStrictEqual(store.getMany([key1, 'unknown', key2]), [value1, null, encode(value2)]);
    });
  });

  describe('exists', () => {
    it('should return true if key exists in local storage', () => {
      const key1 = '123';
      set(key1, new Uint8Array());
      assert.strictEqual(store.exists(key1), true);
    });

    it('should return false for non-existent key', () => {
      set('2', new Uint8Array());
      assert.strictEqual(store.exists('1'), false);
    });
  });

  describe('updateMany', () => {
    it('should set or deleta data in local storage', () => {
      const key1 = '123', key2 = '4', key3 = '1337';
      const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]), value3 = new Uint8Array([7, 8, 9]);
      set(key1, value1);
      set(key2, value2);

      store.updateMany([[key3, value3], [key1, null]]);
      assert.deepStrictEqual(get(key1, key2, key3), [null, value2, value3]);
    });
  });

  describe('increment', () => {
    it('should increment stored number', () => {
      const key = 'counter';
      set(key, 0xefn);
      assert.strictEqual(store.increment(key, 123n), 0x16an);
    });
  });

  describe('compareAndSwap', () => {
    it('should replace stored value if matches old value', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      const newValue = new Uint8Array([0x6a, 0x01, 0, 0]);
      set(key, value);

      assert.strictEqual(store.compareAndSwap(key, value, newValue), true);
      assert.deepStrictEqual(get(key), [newValue]);
    });

    it('should set value if old value is undefined', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);

      assert.strictEqual(store.compareAndSwap(key, undefined, value), true);
      assert.deepStrictEqual(get(key), [value]);
    });

    it('should delete stored value if matches old value and new value is undefined', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      set(key, value);

      assert.strictEqual(store.compareAndSwap(key, value, undefined), true);
      assert.strictEqual(has(key), false);
    });

    it('should return false if stored value does not match old value', () => {
      const key = 'counter';
      const value = new Uint8Array([0xef, 0, 0, 0]);
      set(key, value);

      assert.strictEqual(store.compareAndSwap(key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0])), false);
      assert.deepStrictEqual(get(key), [value]);
    });
  });

  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';
    const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);

    beforeEach(() => {
      set(key1, value1);
      set(key3, value3);
      set(key2, value2);
    });

    it('should return all keys by default', () => {
      assert.deepStrictEqual(store.listKeys(), { keys: [key1, key3, key2] });
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
        assert.deepStrictEqual(store.listKeys(selector), { keys: expectedKeys });
      });
    }
  });

  function get(...keys: string[]) {
    return keys.map(key => store['data'].get(key) ?? null);
  }

  function set(key: string, value: Uint8Array | bigint) {
    store['data'].set(key, value);
  }

  function has(key: string) {
    return store['data'].has(key);
  }
});
