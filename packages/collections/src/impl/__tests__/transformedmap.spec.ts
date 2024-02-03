import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OperationError } from '@mithic/commons';
import { MaybeAsyncMap } from '../../map.ts';
import { TransformedMap } from '../transformedmap.ts';
import { BTreeMap } from '../btreemap.ts';
import { RangeQueryable, rangeQueryable } from '../../range.ts';
import { MockKey, MockKeyStringCodec } from '../../__tests__/mocks.ts';

type MapType = MaybeAsyncMap<string, string> & Iterable<[string, string]> & RangeQueryable<string, string>;

const FloatStringCodec = {
  encode: (value: number) => `${value}`,
  decode: (value: string) => parseFloat(value),
};

const K1 = new MockKey('val1')
const K2 = new MockKey('val2');
const K3 = new MockKey('val3');

describe.each([
  () => new BTreeMap<string, string>(5),
  () => new TransformedMap<string, string, string, string, BTreeMap<string, string>>(new BTreeMap(5))
])(TransformedMap.name, (backingMapFactory: () => MapType) => {
  let map: TransformedMap<MockKey, number, string, string, MapType>;

  beforeEach(async () => {
    map = new TransformedMap(backingMapFactory(), MockKeyStringCodec, FloatStringCodec);
    await map.set(K1, 1);
    await map.set(K2, 2);
  });

  it('should have correct string tag', () => {
    expect(map.toString()).toBe(`[object ${TransformedMap.name}]`);
  });

  it('should have correct rangeQueryable tag', () => {
    expect(map[rangeQueryable]).toBe(true);
  });

  describe('has', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      expect(await map.has(K1)).toBe(true);
      expect(await map.has(K2)).toBe(true);
      expect(await map.has(K3)).toBe(false);
    });
  });

  describe('set/get', () => {
    it('should set and get back value', async () => {
      const value = 3;
      await map.set(K3, value);
      expect(await map.get(K3)).toBe(value);
    });
  });

  describe('delete', () => {
    it('should delete existing key', async () => {
      await map.delete(K2);
      expect(await map.has(K2)).toBe(false);
    });

    it('should do nothing for non-existing key', async () => {
      await map.delete(K3);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      const results = [];
      for await (const result of map.hasMany([K1, K2, K3])) {
        results.push(result);
      }
      expect(results).toEqual([true, true, false]);
    });
  });

  describe('setMany/getMany', () => {
    it('should set and get back values', async () => {
      const value1 = 11;
      const value3 = 3;
      for await (const error of map.setMany([[K1, value1], [K3, value3]])) {
        expect(error).toBeUndefined();
      }
      const results = [];
      for await (const result of map.getMany([K1, K2, K3, new MockKey('val4')])) {
        results.push(result);
      }
      expect(results).toEqual([value1, 2, value3, undefined]);
    });

    it('should return errors from underlying map', async () => {
      if ('setMany' in map.map) return; // skip test

      const cause = new Error('error');
      jest.spyOn(map.map, 'set').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of map.setMany([[K1, 1], [K3, 3]])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to set key`, { detail: K1, cause }),
        new OperationError(`failed to set key`, { detail: K3, cause }),
      ])
    });
  });

  describe('deleteMany', () => {
    it('should delete existing keys and do nothing for non-existing keys', async () => {
      for await (const error of map.deleteMany([K1, K2, K3])) {
        expect(error).toBeUndefined();
      }
      expect(await map.has(K1)).toBe(false);
      expect(await map.has(K2)).toBe(false);
    });

    it('should return errors from underlying map', async () => {
      if ('deleteMany' in map.map) return; // skip test

      const cause = new Error('error');
      jest.spyOn(map.map, 'delete').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of map.deleteMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to delete key`, { detail: K1, cause }),
        new OperationError(`failed to delete key`, { detail: K2, cause }),
      ])
    });
  });

  describe('updateMany', () => {
    it('should set or delete values', async () => {
      const value1 = 11;
      const value3 = 3;
      for await (const error of map.updateMany([[K1, value1], [K2, void 0], [K3, value3]])) {
        expect(error).toBeUndefined();
      }
      expect(await map.get(K1)).toBe(value1);
      expect(await map.has(K2)).toBe(false);
      expect(await map.get(K3)).toBe(value3);
    });

    it('should return errors from underlying map', async () => {
      if ('updateMany' in map.map) return; // skip test

      const cause = new Error('error');
      jest.spyOn(map.map, 'set').mockImplementation(() => { throw cause; });
      jest.spyOn(map.map, 'delete').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of map.updateMany([[K1, 123], [K2, void 0]])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to update key`, { detail: K1, cause }),
        new OperationError(`failed to update key`, { detail: K2, cause }),
      ])
    });
  });

  describe('iterator', () => {
    it('should iterate over keys', () => {
      expect([...map]).toEqual([[K1, 1], [K2, 2]]);
    });
  });

  describe('asyncIterator', () => {
    it('should async iterate over keys', async () => {
      const results = [];
      for await (const entry of map[Symbol.asyncIterator]()) {
        results.push(entry);
      }
      expect(results).toEqual([[K1, 1], [K2, 2]]);
    });
  });

  describe('keys', () => {
    it('should iterate over keys', async () => {
      await map.set(K3, 3);

      const keys = [];
      for await (const key of map.keys({ lower: K1, upper: K3 })) {
        keys.push(key);
      }
      expect(keys).toEqual([K1, K2]);
    });
  });

  describe('values', () => {
    it('should iterate over values', async () => {
      await map.set(K3, 3);

      const values = [];
      for await (const value of map.values({ lower: K1, lowerOpen: true })) {
        values.push(value);
      }
      expect(values).toEqual([2, 3]);
    });
  });

  describe('entries', () => {
    it('should iterate over entries', async () => {
      await map.set(K3, 3);

      const entries = [];
      for await (const entry of map.entries({ upper: K2, upperOpen: false })) {
        entries.push(entry);
      }
      expect(entries).toEqual([[K1, 1], [K2, 2]]);
    });
  });
});
