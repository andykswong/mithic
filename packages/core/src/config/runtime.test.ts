import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Config, runtime } from './index.ts';

const KEYS = {
  config1: 'value1',
  cfg2: 'val2',
};

describe('runtime', () => {
  let config: Map<string, string>;

  beforeEach(() => {
    Config.runtime = config = new Map();
  });

  describe('get', () => {
    for (const [key, expected] of [
      ...Object.entries(KEYS),
      ['unknown', undefined],
    ] as const) {
      it('should get value for key', () => {
        setKeys();
        assert.strictEqual(runtime.get(key), expected);
      });
    }
  });

  describe('getAll', () => {
    it('should return empty list by default', () => {
      assert.deepStrictEqual(runtime.getAll(), []);
    });

    it('should return all keys', () => {
      setKeys();
      assert.deepStrictEqual(runtime.getAll(), Object.entries(KEYS));
    });
  });

  function setKeys() {
    for (const [key, value] of Object.entries(KEYS)) {
      config.set(key, value);
    }
  }
});
