import { jest } from '@jest/globals';
import { ErrorCode, operationError } from '@mithic/commons';
import { MaybeAsyncSet } from '../../set.js';
import { EncodedSet } from '../encodedset.js';

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
  () => new Set<string>(),
  () => new EncodedSet<string>(new Set())
])(EncodedSet.name, (backingSetFactory: () => MaybeAsyncSet<string>) => {
  let set: EncodedSet<Key, string>;

  beforeEach(() => {
    set = new EncodedSet(backingSetFactory(), (k) => k.toString());
    set.add(K1);
    set.add(K2);
  });

  it('should have correct string tag', () => {
    expect(set.toString()).toBe(`[object ${EncodedSet.name}]`);
  });

  describe('has', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      expect(await set.has(K1)).toBe(true);
      expect(await set.has(K2)).toBe(true);
      expect(await set.has(K3)).toBe(false);
    });
  });

  describe('add', () => {
    it('should add value correctly', async () => {
      await set.add(K3);
      expect(await set.set.has(K3.toString())).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete existing key', async () => {
      await set.delete(K2);
      expect(await set.set.has(K2.toString())).toBe(false);
    });

    it('should do nothing for non-existing key', async () => {
      await set.delete(K3);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      const results = [];
      for await (const result of set.hasMany([K1, K2, K3])) {
        results.push(result);
      }
      expect(results).toEqual([true, true, false]);
    });
  });

  describe('addMany', () => {
    it('should add values', async () => {
      for await (const error of set.addMany([K1, K3])) {
        expect(error).toBeUndefined();
      }
      expect(await set.has(K1)).toBe(true);
      expect(await set.has(K3)).toBe(true);
    });

    it('should return errors from underlying set', async () => {
      if (set.set.addMany) return; // skip test

      jest.spyOn(set.set, 'add').mockImplementation(() => { throw new Error('error'); });

      const results = [];
      for await (const error of set.addMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        operationError(`Failed to add key`, ErrorCode.OpFailed, K1, new Error('error')),
        operationError(`Failed to add key`, ErrorCode.OpFailed, K2, new Error('error')),
      ])
    });
  });

  describe('deleteMany', () => {
    it('should delete existing keys and do nothing for non-existing keys', async () => {
      for await (const error of set.deleteMany([K1, K2, K3])) {
        expect(error).toBeUndefined();
      }
      expect(await set.has(K1)).toBe(false);
      expect(await set.has(K2)).toBe(false);
    });

    it('should return errors from underlying set', async () => {
      if (set.set.deleteMany) return; // skip test

      jest.spyOn(set.set, 'delete').mockImplementation(() => { throw new Error('error'); });

      const results = [];
      for await (const error of set.deleteMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        operationError(`Failed to delete key`, ErrorCode.OpFailed, K1, new Error('error')),
        operationError(`Failed to delete key`, ErrorCode.OpFailed, K2, new Error('error')),
      ])
    });
  });

  describe('updateMany', () => {
    it('should add or delete values', async () => {
      for await (const error of set.updateMany([[K1, true], [K3]])) {
        expect(error).toBeUndefined();
      }
      expect(await set.has(K1)).toBe(false);
      expect(await set.has(K3)).toBe(true);
    });

    it('should return errors from underlying set', async () => {
      if (set.set.addMany) return; // skip test

      jest.spyOn(set.set, 'add').mockImplementation(() => { throw new Error('error'); });
      jest.spyOn(set.set, 'delete').mockImplementation(() => { throw new Error('error'); });

      const results = [];
      for await (const error of set.updateMany([[K1, true], [K3]])) {
        results.push(error);
      }
      expect(results).toEqual([
        operationError(`Failed to delete key`, ErrorCode.OpFailed, K1, new Error('error')),
        operationError(`Failed to add key`, ErrorCode.OpFailed, K3, new Error('error')),
      ])
    });
  });
});
