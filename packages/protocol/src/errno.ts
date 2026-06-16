export const ERRNO_CODES = [
  'EACCES', 'EBADF', 'EBUSY', 'EEXIST', 'EFAULT',
  'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENAMETOOLONG',
  'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM',
  'EPIPE', 'ESRCH', 'ETIMEDOUT', 'EXDEV', 'EAGAIN', 'ENOSYS',
  'ELOOP', 'EROFS', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENETUNREACH',
] as const;
export type ErrnoCode = typeof ERRNO_CODES[number];

export function isErrnoCode(x: unknown): x is ErrnoCode {
  return typeof x === 'string' && (ERRNO_CODES as readonly string[]).includes(x);
}

export const SIGNALS = [
  'SIGTERM', 'SIGINT', 'SIGKILL', 'SIGSTOP', 'SIGCONT',
  'SIGPIPE', 'SIGCHLD', 'SIGUSR1', 'SIGUSR2',
] as const;
export type Signal = typeof SIGNALS[number];
