import { describe, expect, it } from '@jest/globals';
import { getEventIndexKey, getEventIndexKeys, getEventIndexRangeQueryOptions, getEventTypePrefixes } from '../indices.js';
import { EventMeta } from '../../event.js';
import { MockId } from '../../__tests__/mocks.js';

const ENCODER = new TextEncoder();

describe(getEventIndexKeys.name, () => {
  it('should return the correct keys for a given event', () => {
    const key = new MockId(ENCODER.encode('12345'));
    const root = new MockId(ENCODER.encode('abcde'));
    const type = 'test';
    const createdAt = 12345;
    const createdAtStr = createdAt.toString(16).padStart(16, '0');
    const event = {
      type,
      link: [],
      root,
      time: createdAt,
    } satisfies EventMeta<MockId>;
    const expectedKeys = [
      `HT::${createdAtStr}::${key}`,
      `HR::${root}::${createdAtStr}::${key}`,
      `HE::${type}::${createdAtStr}::${key}`,
      `HRE::${root}::${type}::${createdAtStr}::${key}`,
      `T::${createdAtStr}::${key}`,
      `R::${root}::${createdAtStr}::${key}`,
      `E::${type}::${createdAtStr}::${key}`,
      `RE::${root}::${type}::${createdAtStr}::${key}`,
    ];
    const results = getEventIndexKeys(key, event);
    expect(results).toEqual(expectedKeys);
  });

  it('should return only head keys if headOnly is true', () => {
    const key = new MockId(ENCODER.encode('12345'));
    const root = new MockId(ENCODER.encode('abcde'));
    const type = 'test';
    const createdAt = 12345;
    const createdAtStr = createdAt.toString(16).padStart(16, '0');
    const event = {
      type,
      link: [],
      root,
      time: createdAt
    } satisfies EventMeta<MockId>;
    const expectedKeys = [
      `HT::${createdAtStr}::${key}`,
      `HR::${root}::${createdAtStr}::${key}`,
      `HE::${type}::${createdAtStr}::${key}`,
      `HRE::${root}::${type}::${createdAtStr}::${key}`,
    ];
    const results = getEventIndexKeys(key, event, true);
    expect(results).toEqual(expectedKeys);
  });
});

describe(getEventIndexRangeQueryOptions.name, () => {
  it('should return the correct range query options', () => {
    const root = new MockId(ENCODER.encode('abcde'));
    const type = 'test';
    const sinceTime = 12345;
    const expectedOptions = {
      gt: `RE::${root}::${type}::${(sinceTime + 1).toString(16).padStart(16, '0')}::`,
      lt: `RE::${root}::${type}::\udbff\udfff`,
    };
    expect(getEventIndexRangeQueryOptions(sinceTime, type, root)).toEqual(expectedOptions);
  });

  it('should return the correct range query options when headOnly is true', () => {
    const root = new MockId(ENCODER.encode('abcde'));
    const type = 'test';
    const sinceTime = 12345;
    const expectedOptions = {
      gt: `HRE::${root}::${type}::${(sinceTime + 1).toString(16).padStart(16, '0')}::`,
      lt: `HRE::${root}::${type}::\udbff\udfff`,
    };
    expect(getEventIndexRangeQueryOptions(sinceTime, type, root, true)).toEqual(expectedOptions);
  });
});

describe(getEventIndexKey.name, () => {
  it('should return the correct key', () => {
    const key = '12345';
    const root = 'abcde';
    const type = 'test';
    const time = 12345;
    const expectedKey = `HRE::${root}::${type}::${time.toString(16).padStart(16, '0')}::${key}`;
    expect(getEventIndexKey(true, key, type, root, time)).toEqual(expectedKey);
  });

  it('should return the correct key when only time is provided', () => {
    const key = '12345';
    const time = 12345;
    const expectedKey = `HT::${time.toString(16).padStart(16, '0')}::${key}`;
    expect(getEventIndexKey(true, key, void 0, void 0, time)).toEqual(expectedKey);
  });

  it('should return the correct key when no time is provided', () => {
    const key = '12345';
    const root = 'abcde';
    const type = 'test';
    const expectedKey = `HRE::${root}::${type}::${key}`;
    expect(getEventIndexKey(true, key, type, root)).toEqual(expectedKey);
  });

  it('should return the correct key when no type is provided', () => {
    const key = '12345';
    const root = 'abcde';
    const time = 12345;
    const expectedKey = `R::${root}::${time.toString(16).padStart(16, '0')}::${key}`;
    expect(getEventIndexKey(false, key, void 0, root, time)).toEqual(expectedKey);
  });

  it('should return the correct key when no key is provided', () => {
    const root = 'abcde';
    const type = 'test';
    const time = 12345;
    const expectedKey = `RE::${root}::${type}::${time.toString(16).padStart(16, '0')}`;
    expect(getEventIndexKey(false, void 0, type, root, time)).toEqual(expectedKey);
  });
});

describe(getEventTypePrefixes.name, () => {
  it('should return the correct prefixes for a given type', () => {
    const type = 'test.example';
    const separator = /[._]+/g;
    const expectedPrefixes = [
      'test.example',
      'test'
    ];
    expect(getEventTypePrefixes(type, separator)).toEqual(expectedPrefixes);
  });
});
