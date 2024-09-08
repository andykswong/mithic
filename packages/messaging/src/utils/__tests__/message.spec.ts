import { describe, expect, it } from '@jest/globals';
import type { Message } from '../../types.ts';
import { getMessageMetadata, isMessage, setMessageMetadata } from '../message.ts';

describe(isMessage.name, () => {
  it.each([
    [{ topic: 'test', contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', metadata: [], data: new Uint8Array([1, 2, 3]) }],
  ])('should return true for a valid message', (message: unknown) => {
    expect(isMessage(message)).toBe(true);
  });

  it.each([
    [{ topic: 'test', contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: 'invalid data' }],
    [{ topic: 1, contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', contentType: 1, metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', contentType: 'bin', metadata: 1, data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', contentType: 'bin', metadata: [['key', null]], data: new Uint8Array([1, 2, 3]) }],
  ])('should return false for an invalid message', (message: unknown) => {
    expect(isMessage(message)).toBe(false);
  });
});

describe(getMessageMetadata.name, () => {
  it.each([
    [{ topic: 'test', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1]) } as Message, 'key2', 'value2'],
    [{ topic: 'test', metadata: [['key', 'value'], ['key2', 'value2'], ['key2', 'value3']], data: new Uint8Array([1]) } as Message, 'key2', 'value2'],
    [{ topic: 'test', metadata: [['key2', 'value2']], data: new Uint8Array([1]) } as Message, 'key', undefined],
    [{ topic: 'test', metadata: [], data: new Uint8Array([1]) }, 'key', undefined],
  ])('should return the correct metadata value', (message: Message, key: string, value: string | undefined) => {
    expect(getMessageMetadata(message, key)).toBe(value);
  });
});

describe(setMessageMetadata.name, () => {
  const KEY = 'key', KEY2 = 'key2', VALUE = 'value', VALUE2 = 'value2';
  const message = () => ({ topic: 'test', metadata: [[KEY, VALUE], [KEY2, VALUE2]], data: new Uint8Array([1]) }) as Message;

  it('should push new metadata entry if not exist', () => {
    const key = 'key3';
    const value = 'value3';
    const msg = message();
    expect(setMessageMetadata(msg, key, value)).toBe(value);
    expect(msg.metadata).toEqual([[KEY, VALUE], [KEY2, VALUE2], [key, value]]);
  });

  it('should override existing metadata entry if override = true', () => {
    const value = 'value3';
    const msg = message();
    expect(setMessageMetadata(msg, KEY2, value, true)).toBe(value);
    expect(msg.metadata).toEqual([[KEY, VALUE], [KEY2, value]]);
  });

  it('should not override existing metadata entry by default', () => {
    const value = 'value3';
    const msg = message();
    expect(setMessageMetadata(msg, KEY2, value)).toBe(VALUE2);
    expect(msg.metadata).toEqual([[KEY, VALUE], [KEY2, VALUE2]]);
  });
});
