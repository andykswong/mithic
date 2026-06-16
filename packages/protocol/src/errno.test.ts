import { expect, test } from 'vitest';
import { ERRNO_CODES, SIGNALS, isErrnoCode } from './errno.ts';

test('ERRNO_CODES includes POSIX subset from tech design', () => {
  for (const c of ['EACCES', 'EBADF', 'ENOENT', 'EPIPE', 'EINVAL', 'ETIMEDOUT', 'EAGAIN']) {
    expect(ERRNO_CODES).toContain(c);
  }
});

test('isErrnoCode narrows valid codes', () => {
  expect(isErrnoCode('ENOENT')).toBe(true);
  expect(isErrnoCode('NOTACODE')).toBe(false);
});

test('SIGNALS includes the documented set', () => {
  for (const s of ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGSTOP', 'SIGCONT', 'SIGPIPE', 'SIGCHLD', 'SIGUSR1', 'SIGUSR2']) {
    expect(SIGNALS).toContain(s);
  }
});
