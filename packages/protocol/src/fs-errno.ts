import type { ErrnoCode } from './errno.ts';

/** The WASI-style error codes used by @mithic/io's FileSystemError. */
export type FileSystemErrorCode =
  | 'access' | 'exist' | 'no-entry' | 'not-directory' | 'is-directory'
  | 'not-empty' | 'invalid' | 'insufficient-space' | 'io' | 'loop'
  | 'name-too-long' | 'not-permitted' | 'read-only' | 'cross-device' | 'unsupported';

/** Maps @mithic/io FileSystemError codes to POSIX errno codes for syscall responses. */
export const FS_ERROR_TO_ERRNO: Record<FileSystemErrorCode, ErrnoCode> = {
  'access': 'EACCES',
  'exist': 'EEXIST',
  'no-entry': 'ENOENT',
  'not-directory': 'ENOTDIR',
  'is-directory': 'EISDIR',
  'not-empty': 'ENOTEMPTY',
  'invalid': 'EINVAL',
  'insufficient-space': 'ENOSPC',
  'io': 'EIO',
  'loop': 'ELOOP',
  'name-too-long': 'ENAMETOOLONG',
  'not-permitted': 'EPERM',
  'read-only': 'EROFS',
  'cross-device': 'EXDEV',
  'unsupported': 'ENOSYS',
};

/** Translate a FileSystemError code to errno, defaulting to EIO for unknown. */
export function fsErrorToErrno(code: string): ErrnoCode {
  return (FS_ERROR_TO_ERRNO as Record<string, ErrnoCode>)[code] ?? 'EIO';
}
