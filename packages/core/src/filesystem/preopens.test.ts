import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { preopens } from './index.ts';

describe('preopens', () => {
  describe('getDirectories', () => {
    it('should return empty list', () => {
      assert.deepStrictEqual(preopens.getDirectories(), []);
    });
  });
});
