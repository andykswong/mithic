import { expect, test } from 'vitest';
import { DEFAULT_FD_ACTIONS, isProcessExit, isProcessReady, type ProcessInit, type Capability } from './process.ts';

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

test('Capability discriminated union narrows correctly', () => {
  const caps: Capability[] = [
    { type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] },
    { type: 'net', origins: ['https://api.example.com'] },
    { type: 'ipc', channels: ['clipboard'] },
    { type: 'process', maxChildren: 4 },
    { type: 'env' },
  ];
  for (const cap of caps) {
    switch (cap.type) {
      case 'fs':
        expect(Array.isArray(cap.paths)).toBe(true);
        expect(Array.isArray(cap.operations)).toBe(true);
        break;
      case 'net':
        expect(Array.isArray(cap.origins)).toBe(true);
        break;
      case 'ipc':
        expect(Array.isArray(cap.channels)).toBe(true);
        break;
      case 'process':
        expect(cap.maxChildren).toBe(4);
        break;
      case 'env':
        expect(cap.type).toBe('env');
        break;
    }
  }
});

test('isProcessReady accepts {type:"ready"} and rejects other shapes', () => {
  expect(isProcessReady({ type: 'ready' })).toBe(true);
  expect(isProcessReady(null)).toBe(false);
  expect(isProcessReady(undefined)).toBe(false);
  expect(isProcessReady(42)).toBe(false);
  expect(isProcessReady({})).toBe(false);
  expect(isProcessReady({ type: 'exit', code: 0 })).toBe(false);
  expect(isProcessReady({ id: 1, call: 'x', args: {} })).toBe(false);
});

test('isProcessExit accepts {type:"exit",code:number} and rejects other shapes', () => {
  expect(isProcessExit({ type: 'exit', code: 0 })).toBe(true);
  expect(isProcessExit({ type: 'exit', code: 1 })).toBe(true);
  expect(isProcessExit(null)).toBe(false);
  expect(isProcessExit(undefined)).toBe(false);
  expect(isProcessExit(42)).toBe(false);
  expect(isProcessExit({})).toBe(false);
  expect(isProcessExit({ type: 'exit' })).toBe(false);
  expect(isProcessExit({ type: 'exit', code: 'string' })).toBe(false);
  expect(isProcessExit({ type: 'ready' })).toBe(false);
  expect(isProcessExit({ id: 1, call: 'x', args: {} })).toBe(false);
});
