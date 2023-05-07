import { ContentId } from '@mithic/commons';
import { getEventIndexKey, getEventIndexKeys, getEventIndexRangeQueryOptions, getEventTypePrefixes, serializeNumber } from '../indices.js';
import { Event, EventMetadata } from '../../event.js';

const ENCODER = new TextEncoder();

describe(getEventIndexKeys.name, () => {
  it('should return the correct keys for a given event', () => {
    const key = { bytes: ENCODER.encode('12345') } as ContentId;
    const event: Event<unknown, EventMetadata<ContentId>> = {
      type: 'test',
      payload: undefined,
      meta: {
        parents: [],
        root: { bytes: ENCODER.encode('abcde') } as ContentId,
        createdAt: 12345
      }
    };
    const expectedKeys = [
      Uint8Array.from([104, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([104, 114, 58, 58, 97, 98, 99, 100, 101, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([104, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([104, 114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([114, 58, 58, 97, 98, 99, 100, 101, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
    ];
    const results = getEventIndexKeys(key, event);
    expect(results).toEqual(expectedKeys);
  });

  it('should return only head keys if headOnly is true', () => {
    const key = { bytes: ENCODER.encode('12345') } as ContentId;
    const event: Event<unknown, EventMetadata<ContentId>> = {
      type: 'test',
      payload: undefined,
      meta: {
        parents: [],
        root: { bytes: ENCODER.encode('abcde') } as ContentId,
        createdAt: 12345
      }
    };
    const expectedKeys = [
      Uint8Array.from([104, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([104, 114, 58, 58, 97, 98, 99, 100, 101, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([104, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
      Uint8Array.from([104, 114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]),
    ];
    const results = getEventIndexKeys(key, event, true);
    expect(results).toEqual(expectedKeys);
  });
});

describe(getEventIndexRangeQueryOptions.name, () => {
  it('should return the correct range query options', () => {
    const root = { bytes: ENCODER.encode('abcde') } as ContentId;
    const type = 'test';
    const sinceTime = 12345;
    const expectedOptions = {
      gt: Uint8Array.from([114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 58, 58, 58]),
      lt: Uint8Array.from([114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 255])
    };
    expect(getEventIndexRangeQueryOptions(sinceTime, type, root)).toEqual(expectedOptions);
  });

  it('should return the correct range query options when headOnly is true', () => {
    const root = { bytes: ENCODER.encode('abcde') } as ContentId;
    const type = 'test';
    const sinceTime = 12345;
    const expectedOptions = {
      gt: Uint8Array.from([104, 114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 58, 58, 58]),
      lt: Uint8Array.from([104, 114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 255])
    };
    expect(getEventIndexRangeQueryOptions(sinceTime, type, root, true)).toEqual(expectedOptions);
  });
});

describe(getEventIndexKey.name, () => {
  it('should return the correct key', () => {
    const key = ENCODER.encode('12345');
    const type = ENCODER.encode('test');
    const root = ENCODER.encode('abcde');
    const time = 12345;
    const expectedKey = Uint8Array.from([104, 114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]);
    expect(getEventIndexKey(true, key, type, root, time)).toEqual(expectedKey);
  });

  it('should return the correct key when only time is provided', () => {
    const key = ENCODER.encode('12345');
    const time = 12345;
    const expectedKey = Uint8Array.from([104, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]);
    expect(getEventIndexKey(true, key, void 0, void 0, time)).toEqual(expectedKey);
  });

  it('should return the correct key when no time is provided', () => {
    const key = ENCODER.encode('12345');
    const type = ENCODER.encode('test');
    const root = ENCODER.encode('abcde');
    const expectedKey = Uint8Array.from([104, 114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 49, 50, 51, 52, 53]);
    expect(getEventIndexKey(true, key, type, root)).toEqual(expectedKey);
  });

  it('should return the correct key when no type is provided', () => {
    const key = ENCODER.encode('12345');
    const root = ENCODER.encode('abcde');
    const time = 12345;
    const expectedKey = Uint8Array.from([114, 58, 58, 97, 98, 99, 100, 101, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57, 58, 58, 49, 50, 51, 52, 53]);
    expect(getEventIndexKey(false, key, void 0, root, time)).toEqual(expectedKey);
  });

  it('should return the correct key when no key is provided', () => {
    const type = ENCODER.encode('test');
    const root = ENCODER.encode('abcde');
    const time = 12345;
    const expectedKey = Uint8Array.from([114, 101, 58, 58, 97, 98, 99, 100, 101, 58, 58, 116, 101, 115, 116, 58, 58, 0, 0, 0, 0, 0, 0, 48, 57]);
    expect(getEventIndexKey(false, void 0, type, root, time)).toEqual(expectedKey);
  });
});

describe(getEventTypePrefixes.name, () => {
  it('should return the correct prefixes for a given type', () => {
    const type = 'test.example';
    const separator = /[._]+/g;
    const expectedPrefixes = [
      Uint8Array.from([116, 101, 115, 116, 46, 101, 120, 97, 109, 112, 108, 101]),
      Uint8Array.from([116, 101, 115, 116])
    ];
    expect(getEventTypePrefixes(type, separator)).toEqual(expectedPrefixes);
  });
});

describe(serializeNumber.name, () => {
  it('should return the correct serialized number for a given value', () => {
    const value = 12345;
    const expectedSerializedNumber = Uint8Array.from([0, 0, 0, 0, 0, 0, 48, 57]);
    expect(serializeNumber(value)).toEqual(expectedSerializedNumber);
  });
});
