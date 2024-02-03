import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { IndexedDBMap } from '../indexeddbmap.ts';
import { RangeQueryOptions, rangeQueryable } from '../../range.ts';

describe(IndexedDBMap.name, () => {
  const dbName = 'test-db';
  const storeName = 'test-store';

  let dbMap: IndexedDBMap<string, string>;

  beforeEach(async () => {
    dbMap = new IndexedDBMap(dbName, storeName);
    await dbMap.start();
  });

  afterEach(async () => {
    await dbMap.clear();
    dbMap.close();
  });

  it('should be started', () => {
    expect(dbMap.started).toBe(true);
  })

  it('should have correct string tag', () => {
    expect(dbMap.toString()).toBe(`[object ${IndexedDBMap.name}]`);
  });

  it('should have correct rangeQueryable tag', () => {
    expect(dbMap[rangeQueryable]).toBe(true);
  });

  describe('close', () => {
    it('should close the map', () => {
      dbMap.close();
      expect(dbMap.started).toBe(false);
    });
  })

  describe('set/get', () => {
    it('should set and get a value', async () => {
      const key = 'foo';
      const value = 'bar';

      await dbMap.set(key, value);
      const result = await dbMap.get(key);

      expect(result).toBe(value);
    });
  });

  describe('delete', () => {
    it('should delete a value', async () => {
      const key = 'foo';
      const value = 'bar';

      await dbMap.set(key, value);
      await dbMap.delete(key);
      const result = await dbMap.get(key);

      expect(result).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all values', async () => {
      const key1 = 'foo';
      const key2 = 'bar';
      const value1 = 'baz';
      const value2 = 'qux';

      await dbMap.set(key1, value1);
      await dbMap.set(key2, value2);
      await dbMap.clear();
      const result1 = await dbMap.get(key1);
      const result2 = await dbMap.get(key2);

      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true if a value exists', async () => {
      const key = 'foo';
      const value = 'bar';

      await dbMap.set(key, value);
      const result = await dbMap.has(key);

      expect(result).toBe(true);
    });

    it('should return false if a value does not exist', async () => {
      const key = 'foo';
      const result = await dbMap.has(key);
      expect(result).toBe(false);
    });
  });

  describe('getMany', () => {
    it('should get multiple values', async () => {
      const key1 = 'foo';
      const key2 = 'bar';
      const value1 = 'baz';
      const value2 = 'qux';

      await dbMap.set(key1, value1);
      await dbMap.set(key2, value2);
      const results = [];
      for await (const result of dbMap.getMany([key1, key2])) {
        results.push(result);
      }

      expect(results).toEqual([value1, value2]);
    });
  });

  describe('hasMany', () => {
    it('should check if multiple values exist', async () => {
      const key1 = 'foo';
      const key2 = 'bar';
      const value1 = 'baz';
      const value2 = 'qux';

      await dbMap.set(key1, value1);
      await dbMap.set(key2, value2);
      const results = [];
      for await (const result of dbMap.hasMany([key1, key2])) {
        results.push(result);
      }

      expect(results).toEqual([true, true]);
    });

    it('should handle non-existent values', async () => {
      const key1 = 'foo';
      const key2 = 'bar';
      const value1 = 'baz';

      await dbMap.set(key1, value1);
      const results = [];
      for await (const result of dbMap.hasMany([key1, key2])) {
        results.push(result);
      }

      expect(results).toEqual([true, false]);
    });
  });

  describe('setMany/getMany', () => {
    it('should set and get values', async () => {
      for await (const error of dbMap.setMany([['foo', '123'], ['bar', '456'], ['baz', '789']])) {
        expect(error).toBeUndefined();
      }
      const values = [];
      for await (const value of dbMap.getMany(['foo', 'bar', 'baz', 'qux'])) {
        values.push(value);
      }
      expect(values).toEqual(['123', '456', '789', undefined]);
    });
  });

  describe('deleteMany', () => {
    it('should delete values', async () => {
      for await (const error of dbMap.setMany([['foo', '123'], ['bar', '456'], ['baz', '789']])) {
        expect(error).toBeUndefined();
      }

      for await (const error of dbMap.deleteMany(['foo', 'bar', 'baz', 'qux'])) {
        expect(error).toBeUndefined();
      }

      for await (const has of dbMap.hasMany(['foo', 'bar', 'baz'])) {
        expect(has).toBe(false);
      }
    });
  });

  describe('updateMany', () => {
    it('should set or delete values', async () => {
      for await (const error of dbMap.setMany([['foo', '9'], ['bar', '10'], ['baz', '11']])) {
        expect(error).toBeUndefined();
      }

      for await (const error of dbMap.updateMany([['foo', '123'], ['bar', void 0], ['baz', '789']])) {
        expect(error).toBeUndefined();
      }
      const values = [];
      for await (const value of dbMap.getMany(['foo', 'bar', 'baz'])) {
        values.push(value);
      }
      expect(values).toEqual(['123', undefined, '789']);
    });
  });

  describe('iteration', () => {
    const ENTRIES: [string, string][] = [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
      ['d', '4'],
    ];

    beforeEach(async () => {
      for await (const error of dbMap.setMany(ENTRIES)) {
        if (error) {
          throw error;
        }
      }
    });

    it('should be async iterable', async () => {
      const entries = [];
      for await (const entry of dbMap) {
        entries.push(entry);
      }
      expect(entries).toEqual(ENTRIES);
    });

    it.each(
      [
        [{}, [ENTRIES[0][1], ENTRIES[1][1], ENTRIES[2][1], ENTRIES[3][1]]],
        [{ reverse: true }, [ENTRIES[3][1], ENTRIES[2][1], ENTRIES[1][1], ENTRIES[0][1]]],
        [{ limit: 2 }, [ENTRIES[0][1], ENTRIES[1][1]]],
        [{ reverse: true, lowerOpen: true, lower: 'a', limit: 2 }, [ENTRIES[3][1], ENTRIES[2][1]]],
        [{ lower: 'a', limit: 2 }, [ENTRIES[0][1], ENTRIES[1][1]]],
        [{ upper: 'c' }, [ENTRIES[0][1], ENTRIES[1][1]]],
        [{ upperOpen: false, upper: 'c' }, [ENTRIES[0][1], ENTRIES[1][1], ENTRIES[2][1]]],
        [{ lowerOpen: true, lower: 'a', upperOpen: false, upper: 'c' }, [ENTRIES[1][1], ENTRIES[2][1]]],
      ] satisfies [RangeQueryOptions<string>, string[]][]
    )('should be iterable by values query: %j', async (query, expectedValues) => {
      const values = [];
      for await (const value of dbMap.values(query)) {
        values.push(value);
      }
      expect(values).toEqual(expectedValues);
    });

    it.each(
      [
        [{}, [ENTRIES[0][0], ENTRIES[1][0], ENTRIES[2][0], ENTRIES[3][0]]],
        [{ reverse: true }, [ENTRIES[3][0], ENTRIES[2][0], ENTRIES[1][0], ENTRIES[0][0]]],
        [{ limit: 2 }, [ENTRIES[0][0], ENTRIES[1][0]]],
        [{ reverse: true, lowerOpen: true, lower: 'a', limit: 2 }, [ENTRIES[3][0], ENTRIES[2][0]]],
        [{ lower: 'a', limit: 2 }, [ENTRIES[0][0], ENTRIES[1][0]]],
        [{ upper: 'c' }, [ENTRIES[0][0], ENTRIES[1][0]]],
        [{ upperOpen: false, upper: 'c' }, [ENTRIES[0][0], ENTRIES[1][0], ENTRIES[2][0]]],
        [{ lowerOpen: true, lower: 'a', upperOpen: false, upper: 'c' }, [ENTRIES[1][0], ENTRIES[2][0]]],
      ] satisfies [RangeQueryOptions<string>, string[]][]
    )('should be iterable by keys query: %j', async (query, expectedKeys) => {
      const keys = [];
      for await (const key of dbMap.keys(query)) {
        keys.push(key);
      }
      expect(keys).toEqual(expectedKeys);
    });
  });
});
