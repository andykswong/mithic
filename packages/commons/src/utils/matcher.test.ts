import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StringMatcher } from './index.ts';

describe('StringMatcher', () => {
  describe('matchExact', () => {
    it('should return a match if the string matches the pattern', () => {
      const value = 'test';
      const stringMatcher = StringMatcher.matchExact(value);
      assert.deepStrictEqual(stringMatcher[Symbol.match](value), [value]);
    });

    it('should return null if the string does not match the pattern', () => {
      const stringMatcher = StringMatcher.matchExact('test');
      assert.equal(stringMatcher[Symbol.match]('not test'), null);
    });
  });

  describe('matchPrefix', () => {
    it('should return a match if the string starts with the pattern', () => {
      const value = 'test';
      const stringMatcher = StringMatcher.matchPrefix(value);
      assert.deepStrictEqual(stringMatcher[Symbol.match](value + 'ing'), [value + 'ing']);
    });

    it('should return null if the string does not start with the pattern', () => {
      const stringMatcher = StringMatcher.matchPrefix('test');
      assert.equal(stringMatcher[Symbol.match]('ntesting'), null);
    });
  });

  describe('matchAll', () => {
    it('should return a match for any string', () => {
      const value = 'test';
      const stringMatcher = StringMatcher.matchAll();
      assert.deepStrictEqual(stringMatcher[Symbol.match](value), [value]);
    });
  });
});
