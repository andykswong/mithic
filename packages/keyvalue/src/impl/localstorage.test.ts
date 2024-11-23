import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { TextCodec } from '@mithic/commons';
import { KeyOrder } from '../types.ts';
import { LocalStorageKeyValueProvider, LocalStorageKeyValueStore } from './index.ts';

const NS = 'ns';
const BUCKET = 'test_bucket';
const PREFIX = 'ns:test_bucket:';

describe('LocalStorageKeyValueProvider', () => {
  let localStorage: Storage;
  let provider: LocalStorageKeyValueProvider;
  let codec: TextCodec;

  beforeEach(() => {
    localStorage = new MockStorage();
    codec = new TextCodec();
    provider = new LocalStorageKeyValueProvider({
      codec,
      keyPrefix: NS,
      storage: localStorage
    });
  });

  describe('open', () => {
    it('should return a LocalStorageKeyValueStore', () => {
      const store = provider.open(BUCKET);
      assert.ok(store instanceof LocalStorageKeyValueStore);
      assert.strictEqual(store.name, BUCKET);
      assert.strictEqual(store['storage'], localStorage);
      assert.strictEqual(store['codec'], codec);
      assert.strictEqual(store['namespace'], PREFIX);
    });
  });
});

describe('LocalStorageKeyValueStore', () => {
  let localStorage: Storage;
  let provider: LocalStorageKeyValueProvider;
  let store: LocalStorageKeyValueStore;
  let codec: TextCodec;

  beforeEach(() => {
    localStorage = new MockStorage();
    codec = new TextCodec();
    provider = new LocalStorageKeyValueProvider({
      codec,
      keyPrefix: NS,
      storage: localStorage
    });
    store = provider.open(BUCKET);
  });

  it('should have correct string tag', () => {
    assert.strictEqual(store.toString(), `[object ${LocalStorageKeyValueStore.name}]`);
  });

  describe('getMany', () => {
    it('should get data from local storage with correct key', () => {
      const key1 = '123', key2 = '4';
      const valueStr1 = 'value', valueStr2 = 'v2';
      set(key1, valueStr1);
      set(key2, valueStr2);
      assert.deepStrictEqual(
        store.getMany([key1, 'unknown', key2]),
        [codec.encode(valueStr1), null, codec.encode(valueStr2)]
      );
    });
  });

  describe('exists', () => {
    it('should return true if key exists in local storage', () => {
      const key1 = '123';
      set(key1, 'value');
      assert.strictEqual(store.exists(key1), true);
    });

    it('should return false for non-existent key', () => {
      set('abc', 'value');
      assert.strictEqual(store.exists('1'), false);
    });
  });

  describe('updateMany', () => {
    it('should set or deleta data in local storage', () => {
      const key1 = '123', key2 = '4', key3 = '1337';
      const valueStr1 = 'value', valueStr2 = 'v2', valueStr3 = 'val3';
      set(key1, valueStr1);
      set(key2, valueStr2);

      store.updateMany([[key3, codec.encode(valueStr3)], [key1, null]]);
      assert.deepStrictEqual(get(key3, key1), [valueStr3, null]);
    });
  });

  describe('increment', () => {
    it('should increment stored number', () => {
      const key = 'counter', valueStr = '0xef';
      set(key, valueStr);

      assert.strictEqual(store.increment(key, 123n), 0x16an);
      assert.deepStrictEqual(get(key), ['0x16a']);
    });
  });

  describe('compareAndSwap', () => {
    it('should replace stored value if matches old value', () => {
      const key = 'counter', valueStr = '0xef', newValue = '0x16a';
      set(key, valueStr);

      assert.strictEqual(store.compareAndSwap(key, codec.encode(valueStr), codec.encode(newValue)), true);
      assert.deepStrictEqual(get(key), [newValue]);
    });

    it('should set value if old value is undefined', () => {
      const key = 'counter', valueStr = '0xef';

      assert.strictEqual(store.compareAndSwap(key, undefined, codec.encode(valueStr)), true);
      assert.deepStrictEqual(get(key), [valueStr]);
    });

    it('should delete stored value if matches old value and new value is undefined', () => {
      const key = 'counter', valueStr = '0xef';
      set(key, valueStr);

      assert.strictEqual(store.compareAndSwap(key, codec.encode(valueStr), undefined), true);
      assert.deepStrictEqual(get(key), [null]);
    });

    it('should return false if stored value does not match old value', () => {
      const key = 'counter', valueStr = '0xef';
      set(key, valueStr);

      assert.strictEqual(store.compareAndSwap(key, codec.encode('random'), codec.encode('newvalue')), false);
      assert.deepStrictEqual(get(key), [valueStr]);
    });
  });

  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';

    beforeEach(() => {
      set(key1, 'val');
      set(key3, 'v3');
      set(key2, 'value2');
      localStorage.setItem('ns:test2:4', 'V4');
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
    return keys.map(key => localStorage.getItem(`${PREFIX}${key}`));
  }

  function set(key: string, value: string) {
    localStorage.setItem(`${PREFIX}${key}`, value);
  }
});

class MockStorage implements Storage {
  data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  key(index: number): string | null {
    let i = 0;
    for (const key of this.data.keys()) {
      if (i++ === index) {
        return key;
      }
    }
    return null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}
