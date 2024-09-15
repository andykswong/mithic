import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { TextCodec } from '@mithic/commons';
import { KeyOrder } from '../types.ts';
import { LocalStorageKeyValueStore } from './index.ts';

describe('LocalStorageKeyValueStore', () => {
  const ns = 'ns';
  const bucket = 'test_bucket';
  const prefix = 'ns:test_bucket:';

  let localStorage: Storage;
  let store: LocalStorageKeyValueStore;
  let codec: TextCodec;

  beforeEach(() => {
    localStorage = new MockStorage();
    codec = new TextCodec();
    store = new LocalStorageKeyValueStore({
      codec,
      keyPrefix: ns,
      storage: localStorage
    });
  });

  it('should have correct string tag', () => {
    assert.strictEqual(store.toString(), `[object ${LocalStorageKeyValueStore.name}]`);
  });

  describe('open', () => {
    it('should return identifier as is', () => {
      assert.strictEqual(store.open(bucket), bucket);
    });
  });

  describe('getMany', () => {
    it('should get data from local storage with correct key', () => {
      const key1 = '123', key2 = '4';
      const valueStr1 = 'value', valueStr2 = 'v2';
      localStorage.setItem(`${prefix}${key1}`, valueStr1);
      localStorage.setItem(`${prefix}${key2}`, valueStr2);
      assert.deepStrictEqual(store.getMany(bucket, [key1, 'unknown', key2]), [codec.encode(valueStr1), null, codec.encode(valueStr2)]);
    });
  });

  describe('exists', () => {
    it('should return true if key exists in local storage', () => {
      const key1 = '123';
      localStorage.setItem(`${prefix}${key1}`, 'value');
      assert.strictEqual(store.exists(bucket, key1), true);
    });

    it('should return false for non-existent key', () => {
      localStorage.setItem(`${prefix}abc`, 'value');
      assert.strictEqual(store.exists(bucket, '1'), false);
    });
  });

  describe('updateMany', () => {
    it('should set or deleta data in local storage', () => {
      const key1 = '123', key2 = '4', key3 = '1337';
      const valueStr1 = 'value', valueStr2 = 'v2', valueStr3 = 'val3';
      localStorage.setItem(`${prefix}${key1}`, valueStr1);
      localStorage.setItem(`${prefix}${key2}`, valueStr2);

      store.updateMany(bucket, [[key3, codec.encode(valueStr3)], [key1, null]]);
      assert.deepStrictEqual(localStorage.getItem(`${prefix}${key3}`), valueStr3);
      assert.strictEqual(localStorage.getItem(`${prefix}${key1}`), null);
    });
  });

  describe('increment', () => {
    it('should increment stored number', () => {
      const key = 'counter';
      const valueStr = '0xef';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      assert.strictEqual(store.increment(bucket, key, 123n), 0x16an);
      assert.deepStrictEqual(localStorage.getItem(`${prefix}${key}`), '0x16a');
    });
  });

  describe('compareAndSwap', () => {
    it('should replace stored value if matches old value', () => {
      const key = 'counter';
      const valueStr = '0xef';
      const newValue = '0x16a';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      assert.strictEqual(store.compareAndSwap(bucket, key, codec.encode(valueStr), codec.encode(newValue)), true);
      assert.deepStrictEqual(localStorage.getItem(`${prefix}${key}`), newValue);
    });

    it('should set value if old value is undefined', () => {
      const key = 'counter';
      const valueStr = '0xef';

      assert.strictEqual(store.compareAndSwap(bucket, key, undefined, codec.encode(valueStr)), true);
      assert.strictEqual(localStorage.getItem(`${prefix}${key}`), valueStr);
    });

    it('should delete stored value if matches old value and new value is undefined', () => {
      const key = 'counter';
      const valueStr = '0xef';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      assert.strictEqual(store.compareAndSwap(bucket, key, codec.encode(valueStr), undefined), true);
      assert.strictEqual(localStorage.getItem(`${prefix}${key}`), null);
    });

    it('should return false if stored value does not match old value', () => {
      const key = 'counter';
      const valueStr = '0xef';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      assert.strictEqual(store.compareAndSwap(bucket, key, codec.encode('random'), codec.encode('newvalue')), false);
      assert.strictEqual(localStorage.getItem(`${prefix}${key}`), valueStr);
    });
  });


  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';

    beforeEach(() => {
      localStorage.setItem(`${prefix}${key1}`, 'val1');
      localStorage.setItem(`${prefix}${key3}`, 'v3');
      localStorage.setItem(`${prefix}${key2}`, 'value2');
      localStorage.setItem(`ns:test2:4`, 'V4');
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
