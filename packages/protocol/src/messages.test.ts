import { expect, test } from 'vitest';
import {
  makeSyscallRequest, isSyscallResponse, isKernelEvent, type SyscallResponse,
} from './messages.ts';

test('makeSyscallRequest builds a correlatable request', () => {
  const req = makeSyscallRequest(7, 'fs/read', { fd: 0, len: 1024 });
  expect(req).toEqual({ id: 7, call: 'fs/read', args: { fd: 0, len: 1024 } });
});

test('isSyscallResponse distinguishes ok and error shapes', () => {
  const ok: SyscallResponse = { id: 1, ok: true, result: 42 };
  const err: SyscallResponse = { id: 1, ok: false, error: { code: 'EBADF', message: 'bad fd' } };
  expect(isSyscallResponse(ok)).toBe(true);
  expect(isSyscallResponse(err)).toBe(true);
  expect(isSyscallResponse({ event: 'signal' })).toBe(false);
});

test('isKernelEvent matches unsolicited events', () => {
  expect(isKernelEvent({ event: 'signal', payload: { signal: 'SIGTERM' } })).toBe(true);
  expect(isKernelEvent({ id: 1, ok: true, result: 0 })).toBe(false);
});
