import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OperationError } from '@mithic/commons';
import { MockKey } from '../../__tests__/mocks.js';
import { BTreeSet, MapSet } from '../mapset.js';
import { BTreeMap } from '../btreemap.js';

const compareKeys = (a: MockKey, b: MockKey) => a.toString().localeCompare(b.toString());

const K1 = new MockKey('val1')
const K2 = new MockKey('val2');
const K3 = new MockKey('val3');

describe.each([
  [MapSet.name, () => {
    const backingMap = new BTreeMap<MockKey, MockKey>(3, compareKeys);
    const set = new MapSet<MockKey, MockKey, BTreeMap<MockKey, MockKey>>(backingMap);
    return [set, backingMap] as const;
  }],
  [BTreeSet.name, () => {
    const set = new BTreeSet<MockKey>(3, compareKeys);
    const backingMap = set['map'];
    return [set, backingMap] as const;
  }],
])('%s', (name, setFactory: () => readonly [
  set: MapSet<MockKey, MockKey, BTreeMap<MockKey, MockKey>>,
  backingMap: BTreeMap<MockKey, MockKey>,
]) => {
  let set: MapSet<MockKey, MockKey, BTreeMap<MockKey, MockKey>>;
  let backingMap: BTreeMap<MockKey, MockKey>;

  beforeEach(() => {
    [set, backingMap] = setFactory();
    set.add(K1);
    set.add(K2);
  });

  it('should have correct string tag', () => {
    expect(set.toString()).toBe(`[object ${name}]`);
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
      expect(backingMap.has(K3)).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete existing key', async () => {
      await set.delete(K2);
      expect(backingMap.has(K2)).toBe(false);
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
      const cause = new Error('error');
      jest.spyOn(backingMap, 'set').mockImplementation(() => { throw cause; });

      const results = [];
      for await (const error of set.addMany([K1, K2])) {
        results.push(error);
      }
      expect(results).toEqual([
        new OperationError(`failed to set value`, { detail: K1, cause }),
        new OperationError(`failed to set value`, { detail: K2, cause }),
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
      const cause = new Error('error');
      jest.spyOn(backingMap, 'delete').mockImplementation(() => { throw cause; });

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
      const cause = new Error('error');
      jest.spyOn(backingMap, 'set').mockImplementation(() => { throw cause; });
      jest.spyOn(backingMap, 'delete').mockImplementation(() => { throw cause; });

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
    it('should iterate over keys', async () => {
      const keys = [];
      for await (const key of set.values()) {
        keys.push(key);
      }
      expect(keys).toEqual([K1, K2]);
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

describe(BTreeSet.name, () => {
  let set: BTreeSet<MockKey>;

  beforeEach(() => {
    set = new BTreeSet<MockKey>(3, compareKeys);
    set.add(K1);
    set.add(K2);
  });

  it('should have correct size', () => {
    expect(set.size).toBe(2);
  });
});
