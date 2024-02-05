import { beforeEach, describe, expect, it } from '@jest/globals';
import { DefaultEnv } from '../../env.ts';
import { AsyncValue, Env } from '../../types.ts';
import { obj } from '../../utils.ts';
import { StdOp } from '../index.ts';

describe('StdOp', () => {
  let env: Env;

  beforeEach(() => {
    env = new DefaultEnv();
  });

  it.each([
    ['in', () => [['test', 'ing', 's'], 2], () => true],
    ['in', () => [['test', 'ing', 's'], 3], () => false],
    ['in', () => [obj({ a: 1, b: 2 }), 'a'], () => true],
    ['.', () => [123, 1], () => null],
    ['.', () => [obj({ a: 'b' }), 'a'], () => 'b'],
    ['.', () => [obj({ a: 'b' }), 'b'], () => null],
    ['.', () => [['a', 'bc'], 1], () => 'bc'],
    ['.', () => [['a', 'bc'], 1, 0], () => 'b'],
    ['.=', () => [obj({ a: 'b' }), 'a', 'e'], (args: AsyncValue[]) => (expect(args[0]).toEqual(obj({ a: 'e' })), 'e')],
    ['.=', () => [obj({ a: 'b' }), 'c', 'd'], (args: AsyncValue[]) => (expect(args[0]).toEqual(obj({ a: 'b', c: 'd' })), 'd')],
    ['.=', () => [[1, 2], 0, 3], (args: AsyncValue[]) => (expect(args[0]).toEqual([3, 2]), 3)],
    ['.=', () => [[1, 2], 'a', 3], (args: AsyncValue[]) => (expect(args[0]).toEqual([1, 2]), null)],
    ['delete', () => [obj({ a: 'b', c: 'd' }), 'a'], (args) => (expect(args[0]).toEqual(obj({ c: 'd' })), true)],
    ['delete', () => [obj({ a: 'b' }), 'c'], (args) => (expect(args[0]).toEqual(obj({ a: 'b' })), true)],
    ['delete', () => [[1, 2], 0], (args) => (expect(args[0]).toEqual([1, 2]), false)],
    ['~', () => [0], () => -1],
    ['~', () => [1], () => -2],
    ['^', () => [true, false], () => 1],
    ['^', () => [true, true], () => 0],
    ['&', () => [true, false], () => 0],
    ['&', () => [true, true], () => 1],
    ['|', () => [true, false], () => 1],
    ['|', () => [false, false], () => 0],
    ['**', () => [2, 3], () => 8],
    ['!==', () => [false, 0], () => true],
  ])('should return correct result for call %#: %s', (fn, args, result) => {
    const argVals = args() as AsyncValue[];
    expect(StdOp[fn as keyof typeof StdOp].apply(env, argVals)).toEqual(result(argVals));
  });
});
