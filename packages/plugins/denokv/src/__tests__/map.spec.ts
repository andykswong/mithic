import { Kv, KvKey, openKv } from '@deno/kv';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { rangeQueryable } from '@mithic/collections';
import { DenoKVMap, DenoKVMapRangeQueryOptions } from '../map.js';

const KEY1 = ['a', 1];
const KEY2 = ['b'];
const KEY3 = ['c', true];
const VALUE1 = 'val1';
const VALUE2 = 'val2';
const VALUE3 = 'val3';
const GET_OPTIONS = { consistency: 'eventual' as const };
const SET_OPTIONS = { expireIn: 10 };

describe(DenoKVMap.name, () => {
  let map: DenoKVMap;
  let kv: Kv;

  beforeEach(async () => {
    kv = await openKv();
    map = new DenoKVMap(kv);
  });

  afterEach(() => {
    try {
      map.close();
    } catch {
      // ignore
    }
  });

  it('should have the correct string tag', () => {
    expect(`${map}`).toBe(`[object ${DenoKVMap.name}]`);
  });

  it('should have correct rangeQueryable tag', () => {
    expect(map[rangeQueryable]).toBe(true);
  });

  describe('close', () => {
    it('should close underlying Kv', async () => {
      const closeSpy = jest.spyOn(kv, 'close');
      map.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
    });

    it('should return existing entry', async () => {
      const getSpy = jest.spyOn(kv, 'get');

      expect(await map.get(KEY1, GET_OPTIONS)).toBe(VALUE1);
      expect(getSpy).toHaveBeenCalledWith(KEY1, GET_OPTIONS);

      expect(await map.get(KEY1)).toBe(VALUE1);
      expect(getSpy).toHaveBeenCalledWith(KEY1, { consistency: map['consistency'] });
    });

    it('should return undefined for missing entry', async () => {
      expect(await map.get(['a', 2])).toBeUndefined();
    });
  });

  describe('has', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
    });

    it('should return true for existing entry', async () => {
      const value = await map.has(KEY1);
      expect(value).toBe(true);
    });

    it('should return false for missing entry', async () => {
      const value = await map.has(KEY2);
      expect(value).toBe(false);
    });
  });

  describe('delete', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
    });

    it('should delete existing entry', async () => {
      await map.delete(KEY1);
      expect((await kv.get(KEY1)).value).toBe(null);
    });

    it('should not throw for missing entry', async () => {
      await map.delete(KEY2);
    });
  });

  describe('set', () => {
    it('should set entry in underlying KV store', async () => {
      const setSpy = jest.spyOn(kv, 'set');
      await map.set(KEY1, VALUE1, SET_OPTIONS);
      expect(setSpy).toHaveBeenCalledWith(KEY1, VALUE1, SET_OPTIONS);
      expect((await kv.get(KEY1)).value).toBe(VALUE1);
    });
  });

  describe('getMany', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
    });

    it('should get all entries', async () => {
      const getManySpy = jest.spyOn(kv, 'getMany');
      const keys = [KEY1, KEY2];
      const values = [];
      for await (const value of map.getMany(keys, GET_OPTIONS)) {
        values.push(value);
      }
      expect(values).toEqual([VALUE1, VALUE2]);
      expect(getManySpy).toHaveBeenCalledWith(keys, GET_OPTIONS);
    });

    it('should return undefined for missing entries', async () => {
      const values = [];
      for await (const value of map.getMany([KEY1, ['c'], KEY2])) {
        values.push(value);
      }
      expect(values).toEqual([VALUE1, undefined, VALUE2]);
    });
  });

  describe('hasMany', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
    });

    it('should return true for existing entries, false for missing entries', async () => {
      const values = [];
      for await (const value of map.hasMany([KEY1, KEY2, ['c']])) {
        values.push(value);
      }
      expect(values).toEqual([true, true, false]);
    });
  });

  describe('deleteMany', () => {
    it('should delete existing entries', async () => {
      for await (const error of map.deleteMany([KEY1, KEY2, ['c']])) {
        expect(error).toBeUndefined();
      }

      for await (const has of map.hasMany([KEY1, KEY2])) {
        expect(has).toBe(false);
      }
    });
  });

  describe('setMany', () => {
    it('should set entries', async () => {
      for await (const error of map.setMany([[KEY1, VALUE1], [KEY2, VALUE2]], SET_OPTIONS)) {
        expect(error).toBeUndefined();
      }
      expect((await kv.get(KEY1)).value).toBe(VALUE1);
      expect((await kv.get(KEY2)).value).toBe(VALUE2);
    });
  });

  describe('updateMany', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
    });

    it('should set or delete entries', async () => {
      const newValue1 = 'val4';
      for await (const error of map.updateMany([[KEY1, newValue1], [KEY2], [KEY3, VALUE3]])) {
        expect(error).toBeUndefined();
      }

      const results = [];
      for await (const value of map.getMany([KEY1, KEY2, KEY3])) {
        results.push(value);
      }
      expect(results).toEqual([newValue1, undefined, VALUE3]);
    });
  });

  describe('asyncIterator', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
    });

    it('should return all entries', async () => {
      const results = [];
      for await (const entry of map) {
        results.push(entry);
      }
      expect(results).toEqual([[KEY1, VALUE1], [KEY2, VALUE2]]);
    });
  });

  describe('entries', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
      await kv.set(KEY3, VALUE3);
    });

    it.each(
      [
        [{}, [[KEY1, VALUE1], [KEY2, VALUE2], [KEY3, VALUE3]] as [KvKey, string][]],
        [{ lower: KEY1, upper: KEY3, upperOpen: false, reverse: true, limit: 2 }, [[KEY3, VALUE3], [KEY2, VALUE2]] as [KvKey, string][]],
        [{ lower: KEY1, lowerOpen: true }, [[KEY2, VALUE2], [KEY3, VALUE3]] as [KvKey, string][]],
        [{ upper: KEY3 }, [[KEY1, VALUE1], [KEY2, VALUE2]] as [KvKey, string][]],
        [{ lower: ['key4'] }, []],
      ] satisfies [DenoKVMapRangeQueryOptions<KvKey>, [KvKey, string][]][]
    )('should return the entries in the range specified %#', async (options, expectedEntries) => {
      const results = [];
      for await (const entry of map.entries(options)) {
        results.push(entry);
      }
      expect(results).toEqual(expectedEntries);
    });
  });

  describe('keys', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
      await kv.set(KEY3, VALUE3);
    });

    it.each(
      [
        [{ lower: KEY1, upper: KEY3, upperOpen: false, reverse: true, limit: 2 }, [KEY3, KEY2]],
        [{ lower: ['key4'] }, []],
      ] satisfies [DenoKVMapRangeQueryOptions<KvKey>, KvKey[]][]
    )('should return the keys in the range specified %#', async (options, expectedKeys) => {
      const results = [];
      for await (const key of map.keys(options)) {
        results.push(key);
      }
      expect(results).toEqual(expectedKeys);
    });
  });

  describe('values', () => {
    beforeEach(async () => {
      await kv.set(KEY1, VALUE1);
      await kv.set(KEY2, VALUE2);
      await kv.set(KEY3, VALUE3);
    });

    it.each([
      [{ lower: KEY1, upper: KEY3, upperOpen: false, reverse: true, limit: 2 }, [VALUE3, VALUE2]],
      [{ lower: ['key4'] }, []],
    ] satisfies [DenoKVMapRangeQueryOptions<KvKey>, string[]][]
    )('should return the values in the range specified %#', async (options, expectedVals) => {
      const results = [];
      for await (const val of map.values(options)) {
        results.push(val);
      }
      expect(results).toEqual(expectedVals);
    });
  });
});
