import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { environment } from './index.ts';

const ARGS = ['arg1', 'arg2'];
const KEYS = {
  PWD: '/path/to/pwd',
  config1: 'value1',
  cfg2: 'val2',
};

describe('environment', () => {
  const processArgv = process.argv;
  const processEnv = process.env;


  beforeEach(() => {
    process.argv = ['arg0', ...ARGS];
    process.env = KEYS;
  });

  afterEach(() => {
    process.argv = processArgv;
    process.env = processEnv;
  });

  describe('getEnvironment', () => {
    it('should return all env keys', () => {
      assert.deepStrictEqual(environment.getEnvironment(), Object.entries(KEYS));
    });
  });

  describe('getArguments', () => {
    it('should return all args', () => {
      assert.deepStrictEqual(environment.getArguments(), ARGS);
    });
  });

  describe('initialCwd', () => {
    it('should return the PWD value', () => {
      assert.strictEqual(environment.initialCwd(), KEYS.PWD);
    });
  });
});
