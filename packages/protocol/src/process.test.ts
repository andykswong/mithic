import { expect, test } from 'vitest';
import { DEFAULT_FD_ACTIONS, type ProcessInit, type SpawnArgs, type Capability } from './process.ts';

test('DEFAULT_FD_ACTIONS inherits stdio', () => {
  expect(DEFAULT_FD_ACTIONS).toEqual({
    0: { action: 'inherit' },
    1: { action: 'inherit' },
    2: { action: 'inherit' },
  });
});

test('ProcessInit shape compiles with required POSIX context', () => {
  const init: ProcessInit = {
    type: 'init', entry: '/bin/cat', args: ['cat'], env: {}, cwd: '/',
    pid: 5, ppid: 0, capabilities: [],
  };
  expect(init.pid).toBe(5);
});

test('Capability supports fs/net/ipc/process/env discriminants', () => {
  const caps: Capability[] = [
    { type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] },
    { type: 'net', origins: ['https://api.example.com'] },
    { type: 'ipc', channels: ['clipboard'] },
    { type: 'process', maxChildren: 4 },
    { type: 'env' },
  ];
  expect(caps).toHaveLength(5);
});
