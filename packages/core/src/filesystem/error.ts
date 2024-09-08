import { Error } from '../io/error.ts';

/** An error indicating a filesystem error. */
export class FileSystemError extends Error<ErrorCode> {
  public constructor(code: ErrorCode) {
    super(code, { name: FileSystemError.name, payload: code, });
  }
}

/** Error codes returned by functions, similar to `errno` in POSIX. */
export const ErrorCode = {
  /** Permission denied, similar to `EACCES` in POSIX. */
  Access: 'access',
  /** Resource unavailable, or operation would block, similar to `EAGAIN` and `EWOULDBLOCK` in POSIX. */
  WouldBlock: 'would-block',
  /** Connection already in progress, similar to `EALREADY` in POSIX. */
  Already: 'already',
  /** Bad descriptor, similar to `EBADF` in POSIX. */
  BadDescriptor: 'bad-descriptor',
  /** Device or resource busy, similar to `EBUSY` in POSIX. */
  Busy: 'busy',
  /** Resource deadlock would occur, similar to `EDEADLK` in POSIX. */
  Deadlock: 'deadlock',
  /** Storage quota exceeded, similar to `EDQUOT` in POSIX. */
  Quota: 'quota',
  /** File exists, similar to `EEXIST` in POSIX. */
  Exist: 'exist',
  /** File too large, similar to `EFBIG` in POSIX. */
  FileTooLarge: 'file-too-large',
  /** Illegal byte sequence, similar to `EILSEQ` in POSIX. */
  IllegalByteSequence: 'illegal-byte-sequence',
  /** Operation in progress, similar to `EINPROGRESS` in POSIX. */
  InProgress: 'in-progress',
  /** Interrupted function, similar to `EINTR` in POSIX. */
  Interrupted: 'interrupted',
  /** Invalid argument, similar to `EINVAL` in POSIX. */
  Invalid: 'invalid',
  /** I/O error, similar to `EIO` in POSIX. */
  Io: 'io',
  /** Is a directory, similar to `EISDIR` in POSIX. */
  IsDirectory: 'is-directory',
  /** Too many levels of symbolic links, similar to `ELOOP` in POSIX. */
  Loop: 'loop',
  /** Too many links, similar to `EMLINK` in POSIX. */
  TooManyLinks: 'too-many-links',
  /** Message too large, similar to `EMSGSIZE` in POSIX. */
  MessageSize: 'message-size',
  /** Filename too long, similar to `ENAMETOOLONG` in POSIX. */
  NameTooLong: 'name-too-long',
  /** No such device, similar to `ENODEV` in POSIX. */
  NoDevice: 'no-device',
  /** No such file or directory, similar to `ENOENT` in POSIX. */
  NoEntry: 'no-entry',
  /** No locks available, similar to `ENOLCK` in POSIX. */
  NoLock: 'no-lock',
  /** Not enough space, similar to `ENOMEM` in POSIX. */
  InsufficientMemory: 'insufficient-memory',
  /** No space left on device, similar to `ENOSPC` in POSIX. */
  InsufficientSpace: 'insufficient-space',
  /** Not a directory or a symbolic link to a directory, similar to `ENOTDIR` in POSIX. */
  NotDirectory: 'not-directory',
  /** Directory not empty, similar to `ENOTEMPTY` in POSIX. */
  NotEmpty: 'not-empty',
  /** State not recoverable, similar to `ENOTRECOVERABLE` in POSIX. */
  NotRecoverable: 'not-recoverable',
  /** Not supported, similar to `ENOTSUP` and `ENOSYS` in POSIX. */
  Unsupported: 'unsupported',
  /** Inappropriate I/O control operation, similar to `ENOTTY` in POSIX. */
  NoTty: 'no-tty',
  /** No such device or address, similar to `ENXIO` in POSIX. */
  NoSuchDevice: 'no-such-device',
  /** Value too large to be stored in data type, similar to `EOVERFLOW` in POSIX. */
  Overflow: 'overflow',
  /** Operation not permitted, similar to `EPERM` in POSIX. */
  NotPermitted: 'not-permitted',
  /** Broken pipe, similar to `EPIPE` in POSIX. */
  Pipe: 'pipe',
  /** Read-only file system, similar to `EROFS` in POSIX. */
  ReadOnly: 'read-only',
  /** Invalid seek, similar to `ESPIPE` in POSIX. */
  InvalidSeek: 'invalid-seek',
  /** Text file busy, similar to `ETXTBSY` in POSIX. */
  TextFileBusy: 'text-file-busy',
  /** Cross-device link, similar to `EXDEV` in POSIX. */
  CrossDevice: 'cross-device',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];
