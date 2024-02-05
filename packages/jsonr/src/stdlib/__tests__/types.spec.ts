import { beforeEach, describe, expect, it } from '@jest/globals';
import { DefaultEnv } from '../../env.ts';
import { Interpreter } from '../../interpreter/index.ts';
import { AsyncValue, Env } from '../../types.ts';
import { obj } from '../../utils.ts';
import * as Types from '../types.ts';

const bindings = {
  test: () => true,
};
const f = ['fn', 'f', ['n'], ['+', 'n', 1]];

describe('StdType', () => {
  let env: Env;
  let interpreter: Interpreter;

  beforeEach(() => {
    env = new DefaultEnv(null, bindings);
    interpreter = new Interpreter();
  });

  it.each([
    ['object', () => [], () => ({})],
    ['object', () => ['a', 2], () => ({ a: 2 })],
    ['object', () => ['a', true, 'c'], () => ({ a: true, c: null })],

    ['string', () => [], () => 'null'],
    ['string', () => [bindings.test], () => 'test'],
    ['string', () => [() => null], () => 'fn#anonymous'],
    ['string', () => [Promise.resolve(1)], () => '{}'],
    ['string', () => [interpreter.eval(f, env)], (args: AsyncValue[]) => `${args[0]}`],

    ['array', () => [], () => []],
    ['array', () => [1, 2], () => [1, 2]],

    ['keys', () => ['val'], () => [0, 1, 2]],
    ['keys', () => [['test', 'ing', 's']], () => [0, 1, 2]],
    ['keys', () => [obj({ a: 1, b: 2 })], () => ['a', 'b']],

    ['values', () => ['val'], () => ['v', 'a', 'l']],
    ['values', () => [['test', 'ing', 's']], () => ['test', 'ing', 's']],
    ['values', () => [obj({ a: 1, b: 2 })], () => [1, 2]],

    ['entries', () => ['val'], () => [[0, 'v'], [1, 'a'], [2, 'l']]],
    ['entries', () => [['test', 'ing']], () => [[0, 'test'], [1, 'ing']]],
    ['entries', () => [obj({ a: 1, b: 2 })], () => [['a', 1], ['b', 2]]],

    ['length', () => ['abc'], () => 3],
    ['length', () => [null], () => 0],
    ['length', () => [3], () => 1],
    ['length', () => [['test', 'ing']], () => 2],
    ['length', () => [obj({ a: 1, b: 2, c: 3 })], () => 3],

    ['map', () => [(s: string) => s + 'd', 'abc'], () => 'abcd'],
    ['map', () => [(s: string) => s.substring(0, 2), ['test', 'ing']], () => ['te', 'in']],

    ['slice', () => [['a', 'bc', 'd'], 1, 3], () => ['bc', 'd']],
    ['slice', () => ['abc', 1, 3], () => 'bc'],
  ])('should return correct result for call %#: %s', (fn, args, result) => {
    const argVals = args() as AsyncValue[];
    expect(Types[fn as keyof typeof Types].apply(env, argVals)).toEqual(result(argVals));
  });
});
