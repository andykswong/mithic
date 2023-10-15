import { beforeEach, describe, expect, it } from '@jest/globals';
import { MockStorage } from '../../__tests__/mocks.js';
import { LocalStorageMap } from '../storagemap.js';

describe(LocalStorageMap.name, () => {
  let localStorage: Storage;
  let map: LocalStorageMap<'1' | '2' | '3', string>;

  beforeEach(() => {
    localStorage = new MockStorage();
    map = new LocalStorageMap('prefix-', localStorage);
  });

  it('should have correct string tag', () => {
    expect(map.toString()).toBe(`[object ${LocalStorageMap.name}]`);
  });

  describe('size', () => {
    it('should return the size of the map', () => {
      localStorage.setItem('prefix-1', 'value1');
      localStorage.setItem('prefix-2', 'value2');

      const size = map.size;
      expect(size).toEqual(2);
    });
  });

  describe('get', () => {
    it('should get data from local storage with prefix', () => {
      localStorage.setItem('prefix-3', 'value');
      const value = map.get('3');
      expect(value).toEqual('value');
    });

    it('should return undefined for non-existent key', () => {
      localStorage.setItem('prefix-2', 'value');
      const value = map.get('1');
      expect(value).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true if prefixed key exists in local storage', () => {
      localStorage.setItem('prefix-1', 'value');
      const value = map.has('1');
      expect(value).toBe(true)
    });

    it('should return false for non-existent key', () => {
      localStorage.setItem('prefix-2', 'value');
      const value = map.has('1');
      expect(value).toBe(false)
    });
  });

  describe('set', () => {
    it('should set data to local storage with prefix', () => {
      map.set('3', 'value');
      const value = localStorage.getItem('prefix-3');
      expect(value).toEqual('value');
    });
  });

  describe('delete', () => {
    it('should delete an item from local storage with prefix', () => {
      localStorage.setItem('prefix-1', 'value');

      map.delete('1');
      expect(localStorage.getItem('prefix-1')).toBeNull();
    });
  });

  describe('clear', () => {
    it('should clear all data from local storage with prefix', () => {
      localStorage.setItem('prefix-1', 'value1');
      localStorage.setItem('prefix-2', 'value2');

      map.clear();
      expect(localStorage.getItem('prefix-1')).toBeNull();
      expect(localStorage.getItem('prefix-2')).toBeNull();
    });
  });

  describe('iterable methods', () => {
    const expectedKeys = ['2', '1'];
    const expectedValues = ['value2', 'value1'];
    const expectedEntries = expectedKeys.map((key, i) => [key, expectedValues[i]]);

    beforeEach(() => {
      localStorage.setItem('prefix-1', 'value1');
      localStorage.setItem('prefix-2', 'value2');
    });

    it('should yield all keys using "keys" method', () => {
      expect([...map.keys()]).toEqual(expectedKeys);
    });

    it('should yield all values using "values" method', () => {
      expect([...map.values()]).toEqual(expectedValues);
    });

    it('should yield all key,value pairs using "entries" method', () => {
      expect([...map.entries()]).toEqual(expectedEntries);
    });

    it('should yield all key,value pairs by iterating itself', () => {
      expect([...map]).toEqual(expectedEntries);
    });

    it('should yield all key-value pairs using "forEach" method', () => {
      const entriesArray: [string, string][] = [];
      map.forEach((value, key) => {
        entriesArray.push([key, value]);
      });
      expect(entriesArray).toEqual(expectedEntries);
    });
  });
});
