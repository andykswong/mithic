import { describe, expect, test } from 'vitest';
import { DEFAULT_FD_ACTIONS, isProcessExit, isProcessReady, type ProcessInit, type Capability, type PreopenDescriptor, type DisplayInfo } from './process.ts';

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

describe('PreopenDescriptor.tty', () => {
  test('accepts an optional tty flag on a pipe preopen', () => {
    const ttyStdin: PreopenDescriptor = { type: 'pipe', tty: true };
    const plainPipe: PreopenDescriptor = { type: 'pipe' };
    expect(ttyStdin.tty).toBe(true);
    expect(plainPipe.tty).toBeUndefined();
  });
});

describe('ProcessInit.display', () => {
  test('accepts an optional display info (available + geometry)', () => {
    const info: DisplayInfo = { available: true, mode: 'window', width: 800, height: 600 };
    const init: ProcessInit = {
      type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 1, ppid: 0,
      capabilities: [], preopens: { 1: { type: 'pipe', tty: true } }, display: info,
    };
    expect(init.display?.available).toBe(true);
    expect(init.display?.width).toBe(800);
  });
  test('display is optional (headless / no-display process)', () => {
    const init: ProcessInit = {
      type: 'init', entry: 'inline', args: [], env: {}, cwd: '/', pid: 2, ppid: 0, capabilities: [],
    };
    expect(init.display).toBeUndefined();
  });
  test('a non-GUI environment is represented as available:false', () => {
    const info: DisplayInfo = { available: false };
    expect(info.available).toBe(false);
    expect(info.width).toBeUndefined();
  });
});
