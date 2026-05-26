import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

import { filesystemErrorCode } from './types.ts';
import { IoError } from '../io/error.ts';

describe('filesystemErrorCode', () => {
  it('returns error code from IoError with string payload', () => {
    const err = new IoError('no-entry');
    strictEqual(filesystemErrorCode(err), 'no-entry');
  });

  it('returns error code from IoError with Node.js-style code', () => {
    const nodeErr = { code: 'ENOENT', message: 'no such file' };
    const err = new IoError(nodeErr);
    strictEqual(filesystemErrorCode(err), 'no-entry');
  });

  it('returns undefined for unrecognized payload', () => {
    const err = new IoError('something-unknown');
    strictEqual(filesystemErrorCode(err), undefined);
  });

  it('converts EISDIR to is-directory', () => {
    const err = new IoError({ code: 'EISDIR', message: 'is a directory' });
    strictEqual(filesystemErrorCode(err), 'is-directory');
  });

  it('converts EACCES to access', () => {
    const err = new IoError({ code: 'EACCES', message: 'permission denied' });
    strictEqual(filesystemErrorCode(err), 'access');
  });

  it('returns undefined for IoError with no payload (empty message)', () => {
    const err = new IoError();
    strictEqual(filesystemErrorCode(err), undefined);
  });

  it('converts EEXIST to exist', () => {
    const err = new IoError({ code: 'EEXIST', message: 'file exists' });
    strictEqual(filesystemErrorCode(err), 'exist');
  });

  it('converts ENOTEMPTY to not-empty', () => {
    const err = new IoError({ code: 'ENOTEMPTY', message: 'directory not empty' });
    strictEqual(filesystemErrorCode(err), 'not-empty');
  });

  it('returns undefined for unknown Node.js code', () => {
    const err = new IoError({ code: 'EUNKNOWN', message: 'unknown' });
    strictEqual(filesystemErrorCode(err), undefined);
  });
});
