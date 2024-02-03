import { describe, expect, it } from '@jest/globals';
import { EntityAttrReducer } from '../../view/index.ts';
import { asArray, asEntries, first, last } from '../reducer.ts';

const ATTR = 'attr';
const KEY1 = 'k1';
const KEY2 = 'k2';
const VALUE1 = 123;
const VALUE2 = 456;

describe('EntityAttrReducers', () => {
  describe('first', () => {
    it('should return the first value', () => {
      expect((first satisfies EntityAttrReducer<number>)(undefined, VALUE1, ATTR, KEY1))
        .toEqual(VALUE1);
      expect((first satisfies EntityAttrReducer<number>)(VALUE1, VALUE2, ATTR, KEY2))
        .toEqual(VALUE1);
    });
  });

  describe('last', () => {
    it('should return the last value', () => {
      expect((last satisfies EntityAttrReducer<number>)(undefined, VALUE1, ATTR, KEY1))
        .toEqual(VALUE1);
      expect((last satisfies EntityAttrReducer<number>)(VALUE1, VALUE2, ATTR, KEY2))
        .toEqual(VALUE2);
    });
  });

  describe('asEntries', () => {
    it('should return values as key-value entries', () => {
      expect((asEntries satisfies EntityAttrReducer<number>)(undefined, VALUE1, ATTR, KEY1))
        .toEqual([[KEY1, VALUE1]]);
      expect((asEntries satisfies EntityAttrReducer<number>)([[KEY1, VALUE1]], VALUE2, ATTR, KEY2))
        .toEqual([[KEY1, VALUE1], [KEY2, VALUE2]]);
    });
  });

  describe('asArray', () => {
    it('should return values as array', () => {
      expect((asArray satisfies EntityAttrReducer<number>)(undefined, VALUE1, ATTR, KEY1))
        .toEqual([VALUE1]);
      expect((asArray satisfies EntityAttrReducer<number>)([VALUE1], VALUE2, ATTR, KEY2))
        .toEqual([VALUE1, VALUE2]);
    });
  });
});
