import { beforeEach, describe, expect, it } from '@jest/globals';
import { get, getAll } from '../runtime.ts';
import { Config } from '../store.ts';

const KEYS = {
  config1: 'value1',
  cfg2: 'val2',
};

describe('config', () => {
  let config: Map<string, string>;

  beforeEach(() => {
    Config.runtime = config = new Map();
  });

  describe('get', () => {
    it.each([
      ...Object.entries(KEYS),
      ['unknown', undefined],
    ])('should get value for key %s', (key, expected) => {
      setKeys();
      expect(get(key)).toBe(expected);
    });
  });

  describe('getAll', () => {
    it('should return empty list by default', () => {
      expect(getAll()).toStrictEqual([]);
    });

    it('should return all keys', () => {
      setKeys();
      expect(getAll()).toStrictEqual(Object.entries(KEYS));
    });
  });

  function setKeys() {
    for (const [key, value] of Object.entries(KEYS)) {
      config.set(key, value);
    }
  }
});
