import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IoError, Error as IoErrorAlias } from './error.ts';

describe('IoError', () => {
  it('toDebugString() returns the message when constructed with a string', () => {
    const err = new IoError('something went wrong');
    assert.equal(err.toDebugString(), 'something went wrong');
  });

  it('toDebugString() returns empty string when constructed with no argument', () => {
    const err = new IoError();
    assert.equal(err.toDebugString(), '');
  });

  it('toDebugString() returns empty string when constructed with empty string', () => {
    const err = new IoError('');
    assert.equal(err.toDebugString(), '');
  });

  it('stores payload property correctly for string', () => {
    const err = new IoError('test');
    assert.equal(err.payload, 'test');
  });

  it('stores payload property correctly for Error object', () => {
    const original = new Error('original error');
    const err = new IoError(original);
    assert.equal(err.payload, original);
    assert.equal(err.toDebugString(), 'original error');
  });

  it('stores payload for object with code property', () => {
    const payload = { code: 'ENOENT', message: 'file not found' };
    const err = new IoError(payload);
    assert.equal(err.payload, payload);
    assert.equal(err.toDebugString(), '[object Object]');
  });

  it('stores payload for number', () => {
    const err = new IoError(42);
    assert.equal(err.payload, 42);
    assert.equal(err.toDebugString(), '42');
  });

  it('stores undefined payload when constructed with no args', () => {
    const err = new IoError();
    assert.equal(err.payload, '');
  });
});

describe('Error alias', () => {
  it('Error export is the IoError class', () => {
    assert.equal(IoErrorAlias, IoError);
  });

  it('instances created via alias are IoError instances', () => {
    const err = new IoErrorAlias('test');
    assert.ok(err instanceof IoError);
    assert.equal(err.toDebugString(), 'test');
  });
});
