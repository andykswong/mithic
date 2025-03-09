import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMessageRecord } from './index.ts';

describe('isMessageRecord', () => {
  for (const [message] of [
    [{ topic: 'test', contentType: 'bin', metadata: [['key', 'value'], ['key2', 'value2']], data: new Uint8Array([1, 2, 3]) }],
    [{ topic: 'test', metadata: [], data: new Uint8Array([1, 2, 3]) }],
  ] as [unknown][]) {
    it('should return true for a valid message', () => {
      assert.strictEqual(isMessageRecord(message), true);
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
      assert.strictEqual(isMessageRecord(message), false);
    });
  }
});
