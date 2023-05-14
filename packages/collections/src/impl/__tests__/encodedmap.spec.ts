import { jest } from '@jest/globals';
import { ErrorCode, operationError } from '@mithic/commons';
import { MaybeAsyncMap } from '../../map.js';
import { EncodedMap } from '../encodedmap.js';

class Key {
  public constructor(private readonly value: string) { }

  public toString(): string {
    return this.value;
  }
}

const K1 = new Key('val1')
const K2 = new Key('val2');
const K3 = new Key('val3');

describe.each([
  () => new Map<string, string>(),
  () => new EncodedMap<string, string>(new Map())
])(EncodedMap.name, (backingMapFactory: () => MaybeAsyncMap<string, string>) => {
  let map: EncodedMap<Key, number, string, string>;

  beforeEach(async () => {
    map = new EncodedMap(backingMapFactory(), {
      encodeKey: (key) => key.toString(),
      encodeValue: (value) => `${value}`,
      decodeValue: (value) => parseFloat(value),
    });
    await map.set(K1, 1);
    await map.set(K2, 2);
  });

  it('should have correct string tag', () => {
    expect(map.toString()).toBe(`[object ${EncodedMap.name}]`);
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
      for await (const result of map.getMany([K1, K2, K3, new Key('val4')])) {
        results.push(result);
      }
      expect(results).toEqual([value1, 2, value3, undefined]);
    });

    it('should return errors from underlying map', async () => {
      if (map.map.setMany) return; // skip test

      jest.spyOn(map.map, 'set').mockImplementation(() => { throw new Error('error'); });

      const results = [];
      for await (const error of map.setMany([[K1, 1], [K3, 3]])) {
        results.push(error);
      }
      expect(results).toEqual([
        operationError(`Failed to set key`, ErrorCode.OpFailed, K1, new Error('error')),
        operationError(`Failed to set key`, ErrorCode.OpFailed, K3, new Error('error')),
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
      if (map.map.deleteMany) return; // skip test

      jest.spyOn(map.map, 'delete').mockImplementation(() => { throw new Error('error'); });

      const results = [];
      for await (const error of map.deleteMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        operationError(`Failed to delete key`, ErrorCode.OpFailed, K1, new Error('error')),
        operationError(`Failed to delete key`, ErrorCode.OpFailed, K2, new Error('error')),
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
      if (map.map.updateMany) return; // skip test

      jest.spyOn(map.map, 'set').mockImplementation(() => { throw new Error('error'); });
      jest.spyOn(map.map, 'delete').mockImplementation(() => { throw new Error('error'); });

      const results = [];
      for await (const error of map.updateMany([[K1, 123], [K2, void 0]])) {
        results.push(error);
      }
      expect(results).toEqual([
        operationError(`Failed to update key`, ErrorCode.OpFailed, K1, new Error('error')),
        operationError(`Failed to update key`, ErrorCode.OpFailed, K2, new Error('error')),
      ])
    });
  });
});
