import { expect, test } from 'vitest';
import { FS_ERROR_TO_ERRNO, fsErrorToErrno, type FileSystemErrorCode } from './fs-errno.ts';
import { isErrnoCode } from './errno.ts';

test('every FileSystemErrorCode maps to a valid ErrnoCode', () => {
  for (const [fsCode, errnoCode] of Object.entries(FS_ERROR_TO_ERRNO)) {
    expect(isErrnoCode(errnoCode), `${fsCode} → ${errnoCode} should be a valid ErrnoCode`).toBe(true);
  }
});

test('FS_ERROR_TO_ERRNO covers all 15 FileSystemErrorCode values', () => {
  const expectedCodes: FileSystemErrorCode[] = [
    'access', 'exist', 'no-entry', 'not-directory', 'is-directory',
    'not-empty', 'invalid', 'insufficient-space', 'io', 'loop',
    'name-too-long', 'not-permitted', 'read-only', 'cross-device', 'unsupported',
  ];
  expect(Object.keys(FS_ERROR_TO_ERRNO)).toHaveLength(expectedCodes.length);
  for (const code of expectedCodes) {
    expect(FS_ERROR_TO_ERRNO).toHaveProperty(code);
  }
});

test('fsErrorToErrno maps known codes correctly', () => {
  expect(fsErrorToErrno('no-entry')).toBe('ENOENT');
  expect(fsErrorToErrno('access')).toBe('EACCES');
  expect(fsErrorToErrno('exist')).toBe('EEXIST');
  expect(fsErrorToErrno('not-directory')).toBe('ENOTDIR');
  expect(fsErrorToErrno('is-directory')).toBe('EISDIR');
  expect(fsErrorToErrno('not-empty')).toBe('ENOTEMPTY');
  expect(fsErrorToErrno('invalid')).toBe('EINVAL');
  expect(fsErrorToErrno('insufficient-space')).toBe('ENOSPC');
  expect(fsErrorToErrno('io')).toBe('EIO');
  expect(fsErrorToErrno('loop')).toBe('ELOOP');
  expect(fsErrorToErrno('name-too-long')).toBe('ENAMETOOLONG');
  expect(fsErrorToErrno('not-permitted')).toBe('EPERM');
  expect(fsErrorToErrno('read-only')).toBe('EROFS');
  expect(fsErrorToErrno('cross-device')).toBe('EXDEV');
  expect(fsErrorToErrno('unsupported')).toBe('ENOSYS');
});

test('fsErrorToErrno defaults to EIO for unknown codes', () => {
  expect(fsErrorToErrno('totally-unknown')).toBe('EIO');
  expect(fsErrorToErrno('')).toBe('EIO');
  expect(fsErrorToErrno('not-a-real-code')).toBe('EIO');
});
