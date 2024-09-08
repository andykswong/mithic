import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getArguments, getEnvironment, initialCwd } from '../environment.ts';

const ARGS = ['arg1', 'arg2'];
const KEYS = {
  PWD: '/path/to/pwd',
  config1: 'value1',
  cfg2: 'val2',
};

describe('environment', () => {
  beforeEach(() => {
    jest.replaceProperty(process, 'argv', ['arg0', ...ARGS]);
    jest.replaceProperty(process, 'env', KEYS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  })

  describe('getEnvironment', () => {
    it('should return all env keys', () => {
      expect(getEnvironment()).toStrictEqual(Object.entries(KEYS));
    });
  });

  describe('getArguments', () => {
    it('should return all args', () => {
      expect(getArguments()).toStrictEqual(ARGS);
    });
  });

  describe('initialCwd', () => {
    it('should return the PWD value', () => {
      expect(initialCwd()).toBe(KEYS.PWD);
    });
  });
});
