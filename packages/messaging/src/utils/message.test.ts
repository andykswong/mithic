import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../types.ts';
import { getMessageMetadata, isMessage, setMessageMetadata } from './index.ts';

describe('isMessage', () => {
  for (const [message] of [
    [{ topic: 'test', contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', metadata: [], data: new Uint8Array([1, 2, 3]) }],
  ] as [unknown][]) {
    it('should return true for a valid message', () => {
      assert.strictEqual(isMessage(message), true);
    });
  }

  for (const [message] of [
    [{ topic: 'test', contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: 'invalid data' }],
    [{ topic: 1, contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', contentType: 1, metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', contentType: 'bin', metadata: 1, data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', contentType: 'bin', metadata: [['key', null]], data: new Uint8Array([1, 2, 3]) }],
  ] as [unknown][]) {
    it('should return false for an invalid message', () => {
      assert.strictEqual(isMessage(message), false);
    });
  }
});

describe('getMessageMetadata', () => {
  for (const [message, key, value] of [
    [{ topic: 'test', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1]) } as Message, 'key2', 'value2'],
    [{ topic: 'test', metadata: [['key', 'value'], ['key2', 'value2'], ['key2', 'value3']], data: new Uint8Array([1]) } as Message, 'key2', 'value2'],
    [{ topic: 'test', metadata: [['key2', 'value2']], data: new Uint8Array([1]) } as Message, 'key', undefined],
    [{ topic: 'test', metadata: [], data: new Uint8Array([1]) } as Message, 'key', undefined],
  ] as const) {
    it('should return the correct metadata value', () => {
      assert.strictEqual(getMessageMetadata(message, key), value);
    });
  }
});

describe('setMessageMetadata', () => {
  const KEY = 'key', KEY2 = 'key2', VALUE = 'value', VALUE2 = 'value2';
  const message = () => ({ topic: 'test', metadata: [[KEY, VALUE], [KEY2, VALUE2]], data: new Uint8Array([1]) }) as Message;

  it('should push new metadata entry if not exist', () => {
    const key = 'key3';
    const value = 'value3';
    const msg = message();
    assert.strictEqual(setMessageMetadata(msg, key, value), value);
    assert.deepStrictEqual(msg.metadata, [[KEY, VALUE], [KEY2, VALUE2], [key, value]]);
  });

  it('should override existing metadata entry if override = true', () => {
    const value = 'value3';
    const msg = message();
    assert.strictEqual(setMessageMetadata(msg, KEY2, value, true), value);
    assert.deepStrictEqual(msg.metadata, [[KEY, VALUE], [KEY2, value]]);
  });

  it('should not override existing metadata entry by default', () => {
    const value = 'value3';
    const msg = message();
    assert.strictEqual(setMessageMetadata(msg, KEY2, value), VALUE2);
    assert.deepStrictEqual(msg.metadata, [[KEY, VALUE], [KEY2, VALUE2]]);
  });
});
