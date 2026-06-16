import { expect, test } from 'vitest';
import { TRANSFER_THRESHOLD_BYTES, PIPE_FLUSH_BYTES, PIPE_FLUSH_MS, INITIAL_CREDIT_BYTES, isPipeMessage } from './pipe.ts';

test('transfer threshold matches tech design (10KB)', () => {
  expect(TRANSFER_THRESHOLD_BYTES).toBe(10 * 1024);
});

test('pipe flush triggers match tech design (16KB / 4ms)', () => {
  expect(PIPE_FLUSH_BYTES).toBe(16 * 1024);
  expect(PIPE_FLUSH_MS).toBe(4);
});

test('initial credit is 64KB', () => {
  expect(INITIAL_CREDIT_BYTES).toBe(64 * 1024);
});

test('isPipeMessage recognizes data/end/error/credit', () => {
  expect(isPipeMessage({ type: 'data', chunk: new Uint8Array() })).toBe(true);
  expect(isPipeMessage({ type: 'end' })).toBe(true);
  expect(isPipeMessage({ type: 'error', code: 'EPIPE' })).toBe(true);
  expect(isPipeMessage({ type: 'credit', bytes: 64 })).toBe(true);
  expect(isPipeMessage({ type: 'init' })).toBe(false);
});

test('isPipeMessage rejects non-objects and missing/invalid type', () => {
  for (const v of [null, undefined, 42, 'str', {}, []]) {
    expect(isPipeMessage(v)).toBe(false);
  }
});
