import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Error } from './index.ts';

describe('Error', () => {
  it('should initialize with given options', () => {
    const cause = new globalThis.Error('Error cause');
    const error = new Error('Error message', {
      name: 'TestError',
      code: 'ABORT_ERR',
      payload: { 'this': 'is a testing' },
      cause
    });

    assert.strictEqual(error.name, 'TestError');
    assert.strictEqual(error.code, 'ABORT_ERR');
    assert.deepStrictEqual(error.payload, { 'this': 'is a testing' });
    assert.strictEqual(error.cause, cause, 'Error cause mismatch');
  });
});
