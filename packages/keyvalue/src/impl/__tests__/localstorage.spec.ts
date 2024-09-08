import { beforeEach, describe, expect, it } from '@jest/globals';
import { TextCodec } from '@mithic/commons';
import { KeyOrder, type KeySelector } from '../../types.ts';
import { LocalStorageKeyValueStore } from '../localstorage.ts';

describe(LocalStorageKeyValueStore.name, () => {
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
    expect(store.toString()).toBe(`[object ${LocalStorageKeyValueStore.name}]`);
  });

  describe('open', () => {
    it('should return identifier as is', () => {
      expect(store.open(bucket)).toBe(bucket);
    });
  });

  describe('getMany', () => {
    it('should get data from local storage with correct key', () => {
      const key1 = '123', key2 = '4';
      const valueStr1 = 'value', valueStr2 = 'v2';
      localStorage.setItem(`${prefix}${key1}`, valueStr1);
      localStorage.setItem(`${prefix}${key2}`, valueStr2);

      expect(store.getMany(bucket, [key1, 'unknown', key2]))
        .toEqual([codec.encode(valueStr1), null, codec.encode(valueStr2)]);
    });
  });

  describe('exists', () => {
    it('should return true if key exists in local storage', () => {
      const key1 = '123';
      localStorage.setItem(`${prefix}${key1}`, 'value');
      expect(store.exists(bucket, key1)).toBe(true);
    });

    it('should return false for non-existent key', () => {
      localStorage.setItem(`${prefix}abc`, 'value');
      expect(store.exists(bucket, '1')).toBe(false);
    });
  });

  describe('updateMany', () => {
    it('should set or deleta data in local storage', () => {
      const key1 = '123', key2 = '4', key3 = '1337';
      const valueStr1 = 'value', valueStr2 = 'v2', valueStr3 = 'val3';
      localStorage.setItem(`${prefix}${key1}`, valueStr1);
      localStorage.setItem(`${prefix}${key2}`, valueStr2);

      store.updateMany(bucket, [[key3, codec.encode(valueStr3)], [key1, null]]);
      expect(localStorage.getItem(`${prefix}${key3}`)).toEqual(valueStr3);
      expect(localStorage.getItem(`${prefix}${key1}`)).toBeNull();
    });
  });

  describe('increment', () => {
    it('should increment stored number', () => {
      const key = 'counter';
      const valueStr = '0xef';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      expect(store.increment(bucket, key, 123n)).toBe(0x16an);
      expect(localStorage.getItem(`${prefix}${key}`)).toEqual('0x16a');
    });
  });

  describe('compareAndSwap', () => {
    it('should replace stored value if matches old value', () => {
      const key = 'counter';
      const valueStr = '0xef';
      const newValue = '0x16a';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      expect(store.compareAndSwap(bucket, key, codec.encode(valueStr), codec.encode(newValue))).toBe(true);
      expect(localStorage.getItem(`${prefix}${key}`)).toEqual(newValue);
    });

    it('should set value if old value is undefined', () => {
      const key = 'counter';
      const valueStr = '0xef';

      expect(store.compareAndSwap(bucket, key, undefined, codec.encode(valueStr))).toBe(true);
      expect(localStorage.getItem(`${prefix}${key}`)).toBe(valueStr);
    });
  
    it('should delete stored value if matches old value and new value is undefined', () => {
      const key = 'counter';
      const valueStr = '0xef';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      expect(store.compareAndSwap(bucket, key, codec.encode(valueStr), undefined)).toBe(true);
      expect(localStorage.getItem(`${prefix}${key}`)).toBe(null);
    });

    it('should return false if stored value does not match old value', () => {
      const key = 'counter';
      const valueStr = '0xef';
      localStorage.setItem(`${prefix}${key}`, valueStr);

      expect(store.compareAndSwap(bucket, key, codec.encode('random'), codec.encode('newvalue'))).toBe(false);
      expect(localStorage.getItem(`${prefix}${key}`)).toBe(valueStr);
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
