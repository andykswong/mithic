import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { MemoryLevel } from 'memory-level';
import { LevelKeyValueStore } from '../keyvalue.ts';
import { dispose } from '@mithic/commons';
import { KeyOrder, StoreError, StoreErrorType, type KeySelector } from '@mithic/keyvalue';

describe(LevelKeyValueStore.name, () => {
  const bucket = 'test-store';
  let level: MemoryLevel<string, Uint8Array>;
  let store: LevelKeyValueStore;

  beforeEach(async () => {
    level = new MemoryLevel({ storeEncoding: 'view' });
    store = new LevelKeyValueStore({ level, batchSize: 3 });
    await store.open(bucket);
  });

  afterEach(async () => {
    await dispose(store);
  });

  it('should have started', () => {
    expect(store.started).toBe(true);
  });

  it('should have the correct string tag', () => {
    expect(`${store}`).toBe(`[object ${LevelKeyValueStore.name}]`);
  });

  describe('open', () => {
    it('should return identifier as is', async () => {
      expect(await store.open(bucket)).toBe(bucket);
    });
  });

  describe('close', () => {
    it('should delete sublevel handle', async () => {
      store.close(bucket);
      expect(store['sublevels'].has(bucket)).toBe(false);
    });
  });

  describe('getMany', () => {
    const key1 = '123', key2 = '4';
    const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2]]);
    });

    it('should get data from store', async () => {
      expect(await get([key1, 'unknown', key2])).toEqual([value1, null, value2]);
    });

    it('throws if trying to get a non-opened store', async () => {
      await expect(() => store.getMany('unknown', ['key']))
        .rejects.toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('exists', () => {
    const key = '123', value = new Uint8Array([4, 5, 6]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should return true if key exists in local storage', async () => {
      expect(await store.exists(bucket, key)).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      expect(await store.exists(bucket, '1')).toBe(false);
    });

    it('throw if trying to check a non-opened store', async () => {
      await expect(() => store.exists('unknown', 'key'))
        .rejects.toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('updateMany', () => {
    const key1 = '123', key2 = '4', key3 = '1337';
    const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]), value3 = new Uint8Array([7, 8, 9]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2]]);
    });

    it('should set or deleta data in local storage', async () => {
      await store.updateMany(bucket, [[key3, value3], [key1, null]]);
      expect(await get([key1, key2, key3])).toEqual([null, value2, value3]);
    });

    it('throw if trying to update a non-opened store', async () => {
      await expect(() => store.updateMany('unknown', [['123', new Uint8Array([1])]]))
        .rejects.toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('increment', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should increment stored number', async () => {
      expect(await store.increment(bucket, key, 123n)).toBe(0x16an);
      expect(await get([key])).toEqual([new Uint8Array([0x6a, 0x01, 0, 0, 0, 0, 0, 0])]);
    });

    it('throw if trying to update a non-opened store', async () => {
      await expect(() => store.increment('unknown', 'key', 1n))
        .rejects.toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('compareAndSwap', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should replace stored value if matches old value', async () => {
      const newValue = new Uint8Array([0x6a, 0x01, 0, 0]);
      expect(await store.compareAndSwap(bucket, key, value, newValue)).toBe(true);
      expect(await get([key])).toEqual([newValue]);
    });

    it('should set value if old value is undefined', async () => {
      const key = 'counter2';
      expect(await store.compareAndSwap(bucket, key, undefined, value)).toBe(true);
      expect(await get([key])).toEqual([value]);
    });

    it('should delete stored value if matches old value and new value is undefined', async () => {
      expect(await store.compareAndSwap(bucket, key, value, undefined)).toBe(true);
      expect(await store.exists(bucket, key)).toBe(false);
    });

    it('should return false if stored value does not match old value', async () => {
      expect(await store.compareAndSwap(bucket, key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0]))).toBe(false);
      expect(await get([key])).toEqual([value]);
    });

    it('throw if trying to update a non-opened store', async () => {
      await expect(() => store.compareAndSwap('unknown', 'key', new Uint8Array([1]), undefined))
        .rejects.toThrowError(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';
    const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2], [key3, value3]]);
    });

    it('should return all keys by default', async () => {
      expect(await store.listKeys(bucket)).toEqual({ keys: [key1, key2, key3] });
    });

    it.each([
      [{} as KeySelector, [key1, key2, key3]],
      [{ order: KeyOrder.Asc }, [key1, key2, key3]],
      [{ order: KeyOrder.Desc }, [key3, key2, key1]],
      [{ start: key2, order: KeyOrder.Asc }, [key2, key3]],
      [{ end: key2, order: KeyOrder.Asc }, [key1]],
      [{ end: key3, order: KeyOrder.Desc }, [key2, key1]],
      [{ start: key2, end: key3 }, [key2]],
      [{ start: key2, end: key2, order: KeyOrder.Asc }, []],
    ])('should return filtered keys in correct order %#', async (
      selector: KeySelector, keys: string[], cursor: string | undefined = undefined
    ) => {
      expect(await store.listKeys(bucket, selector)).toEqual({ keys, cursor });
    });

    describe('cursor', () => {
      const key4 = '4', key5 = '5', value4 = new Uint8Array([4]), value5 = new Uint8Array([5]);

      beforeEach(async () => {
        await set([[key4, value4], [key5, value5]]);
      });

      it('should support pagination', async () => {
        const query1 = await store.listKeys(bucket);
        expect(query1).toEqual({ keys: [key1, key2, key3], cursor: key3 });

        const query2 = await store.listKeys(bucket, {}, key3);
        expect(query2).toEqual({ keys: [key4, key5] });
      });

      it('should support pagination in reverse', async () => {
        const query1 = await store.listKeys(bucket, { end: key5, order: KeyOrder.Desc });
        expect(query1).toEqual({ keys: [key4, key3, key2], cursor: key2 });

        const query2 = await store.listKeys(bucket, { end: key5, order: KeyOrder.Desc }, key2);
        expect(query2).toEqual({ keys: [key1] });
      });

    });
  });

  async function get(keys: string[]): Promise<(Uint8Array | null)[]> {
    return (await level.sublevel<string, Uint8Array>(bucket, { keyEncoding: 'utf8', valueEncoding: 'view' })
      .getMany(keys)).map(v => v ?? null);
  }

  async function set(keyValues: [string, Uint8Array][]) {
    const tx = level
      .sublevel<string, Uint8Array>(bucket, { keyEncoding: 'utf8', valueEncoding: 'view' })
      .batch();
    for (const [key, value] of keyValues) {
      tx.put(key, value);
    }
    await tx.write();
  }
});
