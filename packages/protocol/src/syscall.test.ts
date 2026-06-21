import { expect, test } from 'vitest';
import { SYSCALL_NAMES, isSyscallName } from './syscall.ts';

test('SYSCALL_NAMES covers all dispatcher call families', () => {
  // The full set the kernel dispatcher handles, including the relay pipe/* calls
  // folded in as first-class members (C2).
  const expected = [
    'fs/open', 'fs/read', 'fs/write', 'fs/close', 'fs/stat', 'fs/readdir',
    'fs/mkdir', 'fs/unlink', 'fs/rmdir', 'fs/rename', 'fs/symlink', 'fs/readlink',
    'fs/link', 'fs/chmod', 'fs/utimes', 'fs/realpath', 'fs/pipe',
    'ipc/listen', 'ipc/accept', 'ipc/connect',
    'dom/mutate', 'net/fetch',
    'process/spawn', 'process/pipeline', 'process/wait', 'process/exit',
    'process/getpid', 'process/getppid', 'process/getcwd', 'process/chdir',
    'pipe/read', 'pipe/write', 'pipe/close',
  ];
  expect([...SYSCALL_NAMES].sort()).toEqual([...expected].sort());
});

test('SYSCALL_NAMES has no duplicates', () => {
  expect(new Set(SYSCALL_NAMES).size).toBe(SYSCALL_NAMES.length);
});

test('isSyscallName recognizes known calls and rejects unknown ones', () => {
  expect(isSyscallName('fs/open')).toBe(true);
  expect(isSyscallName('pipe/read')).toBe(true);
  expect(isSyscallName('net/fetch')).toBe(true);
  expect(isSyscallName('bogus/call')).toBe(false);
  expect(isSyscallName('')).toBe(false);
});
