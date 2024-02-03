import { describe, expect, it, test } from '@jest/globals';
import { GenerationalIdMap } from '../genidmap.ts';
import { SparseSetMap } from '../sparseset.ts';
import { GenerationalId } from '../index.ts';

describe.each([
  [GenerationalIdMap.name, GenerationalIdMap],
  [SparseSetMap.name, SparseSetMap]
])('%s', (name, MapType) => {
  it('has the correct string tag', () => {
    expect(`${new MapType<string>()}`).toBe(`[object ${name}]`);
  });

  test('clear() should empty the container', () => {
    const map = new MapType<string>();
    map.set(GenerationalId.create(0, 1), '1');
    map.set(GenerationalId.create(1, 2), '2');

    expect(map.size).toBe(2);

    map.clear();
    expect(map.size).toBe(0);
  });

  test('delete() should remove value and return true', () => {
    const map = new MapType<string>();
    const id = GenerationalId.create(0, 1);
    map.set(id, 'hello');

    expect(map.delete(id)).toBeTruthy();
    expect(map.size).toBe(0);
  });

  test('delete() should do nothing and return false for non-existent id', () => {
    const map = new MapType<string>();
    map.set(GenerationalId.create(0, 1), 'hello');

    expect(map.delete(999)).toBeFalsy();
    expect(map.size).toBe(1);
  });

  test('set() should insert key-value to map', () => {
    const map = new MapType<string>();
    expect(map.size).toBe(0);

    const id = GenerationalId.create(0, 1);
    const value = 'hello';
    expect(map.set(id, value)).toBe(map);
    expect(map.size).toBe(1);
    expect(map.get(id)).toBe(value);
    expect(map.has(id)).toBeTruthy();
  });

  test('set() should update value of existing key', () => {
    const map = new MapType<string>();
    const id = GenerationalId.create(0, 1);
    map.set(id, 'hello');

    const newValue = 'new';
    map.set(id, newValue);

    expect(map.get(id)).toBe(newValue);
  });

  test('get() should return undefined for non-existent key', () => {
    const map = new MapType<string>();
    expect(map.get(123)).toBeUndefined();
  });

  describe('iterators', () => {
    test('foreach() should loop through all id-values', () => {
      const map = new MapType<string>();
      const value1 = 'hello', value2 = 'world';
      const id1 = GenerationalId.create(0, 1), id2 = GenerationalId.create(10, 2);
      map.set(id1, value1);
      map.set(id2, value2);

      const results: [number, string][] = [];
      map.forEach((value, id) => results.push([id, value]));

      expect(results).toEqual([[id1, value1], [id2, value2]]);
    });

    test('entries() should iterate through all id-values', () => {
      const map = new MapType<string>();
      const value1 = 'hello', value2 = 'world';
      const id1 = GenerationalId.create(0, 1), id2 = GenerationalId.create(10, 2);
      map.set(id1, value1);
      map.set(id2, value2);

      const results: [number, string][] = [];
      for (const entry of map.entries()) {
        results.push(entry);
      }

      expect(results).toEqual([[id1, value1], [id2, value2]]);
    });

    test('[Symbol.iterator]() should iterate through all id-values', () => {
      const map = new MapType<string>();
      const value1 = 'hello', value2 = 'world';
      const id1 = GenerationalId.create(0, 1), id2 = GenerationalId.create(10, 2);
      map.set(id1, value1);
      map.set(id2, value2);

      const results: [number, string][] = [];
      for (const entry of map) {
        results.push(entry);
      }

      expect(results).toEqual([[id1, value1], [id2, value2]]);
    });

    test('keys() should iterate through all ids', () => {
      const map = new MapType<string>();
      const value1 = 'hello', value2 = 'world';
      const id1 = GenerationalId.create(0, 1), id2 = GenerationalId.create(10, 2);
      map.set(id1, value1);
      map.set(id2, value2);

      const results: number[] = [];
      for (const key of map.keys()) {
        results.push(key);
      }

      expect(results).toEqual([id1, id2]);
    });

    test('values() should iterate through all values', () => {
      const map = new MapType<string>();
      const value1 = 'hello', value2 = 'world';
      const id1 = GenerationalId.create(0, 1), id2 = GenerationalId.create(10, 2);
      map.set(id1, value1);
      map.set(id2, value2);

      const results: string[] = [];
      for (const value of map.values()) {
        results.push(value);
      }

      expect(results).toEqual([value1, value2]);
    });
  });
});
