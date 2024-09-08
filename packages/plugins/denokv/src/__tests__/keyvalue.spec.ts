import { type Kv, openKv } from '@deno/kv';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { dispose } from '@mithic/commons';
import { KeyOrder, type KeySelector } from '@mithic/keyvalue';
import { DenoKeyValueStore } from '../keyvalue.ts';

const BUCKET = 'bucket';
const KEY1 = 'a'
const KEY2 = 'b';
const KEY3 = 'c3';
const VALUE1 = new Uint8Array([1]);
const VALUE2 = new Uint8Array([2]);
const VALUE3 = new Uint8Array([3]);
const CONSISTENCY = 'eventual' as const;
const EXPIRE_IN = 10;

describe(DenoKeyValueStore.name, () => {
  let store: DenoKeyValueStore;
  let kv: Kv;

  beforeEach(async () => {
    kv = await openKv();
    store = new DenoKeyValueStore({ kv, consistency: CONSISTENCY, expireIn: EXPIRE_IN, batchSize: 3 });
  });

  afterEach(() => {
    dispose(store);
  });

  it('should have the correct string tag', () => {
    expect(`${store}`).toBe(`[object ${DenoKeyValueStore.name}]`);
  });

  describe('dispose', () => {
    it('should close underlying Kv', async () => {
      const closeSpy = jest.spyOn(kv, 'close');
      dispose(store);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('exists', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
    });

    it('should return true for existing entry', async () => {
      expect(await store.exists(BUCKET, KEY1)).toBe(true);
    });

    it('should return false for missing entry', async () => {
      expect(await store.exists(BUCKET, KEY2)).toBe(false);
    });
  });

  describe('getMany', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.set([BUCKET, KEY2], VALUE2);
    });

    it('should get all entries', async () => {
      const getManySpy = jest.spyOn(kv, 'getMany');
      expect(await store.getMany(BUCKET, [KEY1, KEY2])).toEqual([VALUE1, VALUE2]);
      expect(getManySpy).toHaveBeenCalledWith([[BUCKET, KEY1], [BUCKET, KEY2]], { consistency: CONSISTENCY });
    });

    it('should return null for missing entries', async () => {
      expect(await store.getMany(BUCKET, [KEY1, 'null', KEY2])).toEqual([VALUE1, null, VALUE2]);
    });
  });

  describe('updateMany', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.set([BUCKET, KEY2], VALUE2);
    });

    it('should set or delete entries', async () => {
      const newValue1 = new Uint8Array([4]);
      await store.updateMany(BUCKET, [[KEY1, newValue1], [KEY2, null], [KEY3, VALUE3]]);
      expect(await store.getMany(BUCKET, [KEY1, KEY2, KEY3])).toEqual([newValue1, null, VALUE3]);
    });
  });

  describe('listKeys', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.set([BUCKET, KEY2], VALUE2);
      await kv.set([BUCKET, KEY3], VALUE3);
    });

    it.each([
      [{}, [KEY1, KEY2, KEY3]],
      [{ start: KEY1, end: 'key4', order: KeyOrder.Desc }, [KEY3, KEY2, KEY1]],
      [{ start: KEY2 }, [KEY2, KEY3]],
      [{ end: KEY3 }, [KEY1, KEY2]],
      [{ start: 'key4' }, []],
    ])('should return keys within specified selector %#', async (selector: KeySelector, keys) => {
      const results = await store.listKeys(BUCKET, selector);
      expect(results.keys).toEqual(keys);
    });

    it('should support pagination', async () => {
      const key4 = 'key4', key5 = 'key5';
      const value4 = new Uint8Array([4]), value5 = new Uint8Array([5]);
      await kv.set([BUCKET, key4], value4);
      await kv.set([BUCKET, key5], value5);

      const results1 = await store.listKeys(BUCKET, { order: KeyOrder.Desc });
      expect(results1.keys).toEqual([key5, key4, KEY3]);

      const results2 = await store.listKeys(BUCKET, { order: KeyOrder.Desc }, results1.cursor);
      expect(results2.keys).toEqual([KEY2, KEY1]);

      const results3 = await store.listKeys(BUCKET, { order: KeyOrder.Desc }, results2.cursor);
      expect(results3).toEqual({ keys: [] });
    })
  });

  describe('increment', () => {
    const key = 'counter';
    const value = 0xefn;

    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.atomic().sum([BUCKET, key], value).commit();
    });

    it('should increment stored number', async () => {
      expect(await store.increment(BUCKET, key, 123n)).toBe(0x16an);
    });

    it('throw if trying to update a non int key', async () => {
      await expect(() => store.increment(BUCKET, KEY1, 1n))
        .rejects.toThrowError('expect bigint');
    });
  });


  describe('compareAndSwap', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await kv.set([BUCKET, key], value);
    });

    it('should replace stored value if matches old value', async () => {
      const newValue = new Uint8Array([0x6a, 0x01, 0, 0]);
      expect(await store.compareAndSwap(BUCKET, key, value, newValue)).toBe(true);
      expect(await store.getMany(BUCKET, [key])).toEqual([newValue]);
    });

    it('should set value if old value is undefined', async () => {
      const key = 'counter2';
      expect(await store.compareAndSwap(BUCKET, key, undefined, value)).toBe(true);
      expect(await store.getMany(BUCKET, [key])).toEqual([value]);
    });

    it('should delete stored value if matches old value and new value is undefined', async () => {
      expect(await store.compareAndSwap(BUCKET, key, value, undefined)).toBe(true);
      expect(await store.exists(BUCKET, key)).toBe(false);
    });

    it('should return false if stored value does not match old value', async () => {
      expect(await store.compareAndSwap(BUCKET, key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0]))).toBe(false);
    });
  });
});
