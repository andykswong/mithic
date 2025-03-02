import assert from 'node:assert/strict';
import type { Mock } from 'node:test';

export function assertCallCount<Ret, Args extends unknown[]>(
  f: (...args: Args) => Ret, count: number
): void {
  assert.strictEqual((f as Mock<(...args: Args) => Ret>).mock.callCount(), count);
}

export function assertCalledWith<Ret, Args extends unknown[]>(
  f: (...args: Args) => Ret, index: number, ...args: unknown[]
): void {
  assert.deepStrictEqual((f as Mock<(...args: Args) => Ret>).mock.calls[index].arguments, args);
}

export function assertCalledWithArg<Ret, Args extends unknown[], I extends number>(
  f: (...args: Args) => Ret, index: number, argIndex: I, val: Args[I]
): void {
  assert.deepStrictEqual((f as Mock<(...args: Args) => Ret>).mock.calls[index].arguments[argIndex], val);
}

export function getCallArg<Ret, Args extends unknown[], I extends number>(
  f: (...args: Args) => Ret, index: number, argIndex: I
): Args[I] {
  return (f as Mock<(...args: Args) => Ret>).mock.calls[index].arguments[argIndex];
}

export function mocked<Ret, Args extends unknown[]>(f: (...args: Args) => Ret): Mock<(...args: Args) => Ret> {
  return f as Mock<(...args: Args) => Ret>;
}
