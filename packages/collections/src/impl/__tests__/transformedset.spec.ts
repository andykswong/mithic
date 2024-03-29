import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OperationError } from '@mithic/commons';
import { MaybeAsyncSet } from '../../set.ts';
import { TransformedSet } from '../transformedset.ts';
import { KeyValueIterable, rangeQueryable } from '../../range.ts';
import { MockKey, MockKeyStringCodec } from '../../__tests__/mocks.ts';

type SetType = MaybeAsyncSet<string> & Iterable<string> & KeyValueIterable<string, string>;

const K1 = new MockKey('val1')
const K2 = new MockKey('val2');
const K3 = new MockKey('val3');

describe.each([
  () => new Set<string>(),
  () => new TransformedSet<string, string, Set<string>>(new Set())
])(TransformedSet.name, (backingSetFactory: () => SetType) => {
  let set: TransformedSet<MockKey, string, SetType>;

  beforeEach(() => {
    set = new TransformedSet(backingSetFactory(), MockKeyStringCodec);
    set.add(K1);
    set.add(K2);
  });

  it('should have correct string tag', () => {
    expect(set.toString()).toBe(`[object ${TransformedSet.name}]`);
  });

  it('should have correct rangeQueryable tag', () => {
    expect(set[rangeQueryable]).toBe(undefined);
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
      if ('addMany' in set.set) return; // skip test

      const cause = new Error('error');
      jest.spyOn(set.set, 'add').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of set.addMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to add key`, { detail: K1, cause }),
        new OperationError(`failed to add key`, { detail: K2, cause }),
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
      if ('deleteMany' in set.set) return; // skip test

      const cause = new Error('error');
      jest.spyOn(set.set, 'delete').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of set.deleteMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to delete key`, { detail: K1, cause }),
        new OperationError(`failed to delete key`, { detail: K2, cause }),
      ])
    });
  });

  describe('updateMany', () => {
    it('should add or delete values', async () => {
      for await (const error of set.updateMany([[K1, false], [K3, true]])) {
        expect(error).toBeUndefined();
      }
      expect(await set.has(K1)).toBe(false);
      expect(await set.has(K3)).toBe(true);
    });

    it('should return errors from underlying set', async () => {
      if ('addMany' in set.set) return; // skip test

      const cause = new Error('error');
      jest.spyOn(set.set, 'add').mockImplementation(() => { throw cause; });
      jest.spyOn(set.set, 'delete').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of set.updateMany([[K1, true], [K3]])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to update key`, { detail: K1, cause }),
        new OperationError(`failed to update key`, { detail: K3, cause }),
      ])
    });
  });

  describe('iterator', () => {
    it('should iterate over keys', () => {
      expect([...set]).toEqual([K1, K2]);
    });
  });

  describe('asyncIterator', () => {
    it('should async iterate over keys', async () => {
      const results = [];
      for await (const key of set[Symbol.asyncIterator]()) {
        results.push(key);
      }
      expect(results).toEqual([K1, K2]);
    });
  });

  describe('keys', () => {
    it('should iterate over keys', async () => {
      const keys = [];
      for await (const key of set.keys()) {
        keys.push(key);
      }
      expect(keys).toEqual([K1, K2]);
    });
  });

  describe('values', () => {
    it('should iterate over values', async () => {
      const values = [];
      for await (const value of set.values()) {
        values.push(value);
      }
      expect(values).toEqual([K1, K2]);
    });
  });

  describe('entries', () => {
    it('should iterate over entries', async () => {
      const entries = [];
      for await (const entry of set.entries()) {
        entries.push(entry);
      }
      expect(entries).toEqual([[K1, K1], [K2, K2]]);
    });
  });
});
