import { beforeEach, describe, expect, it } from '@jest/globals';
import { DefaultEnv } from '../../env.ts';
import { Interpreter } from '../../interpreter/index.ts';
import { AsyncValue, Env } from '../../types.ts';
import { obj } from '../../utils.ts';
import * as Predicates from '../predicates.ts';

const f = ['fn', 'f', ['n'], ['+', 'n', 1]];
const m = ['macro', 'f', ['n'], ['+', 'n', 1]];

describe('StdType.Predicates', () => {
  let env: Env;
  let interpreter: Interpreter;

  beforeEach(() => {
    env = new DefaultEnv();
    interpreter = new Interpreter();
  });

  it.each([
    ['isEmpty', () => ['abc'], () => false],
    ['isEmpty', () => [''], () => true],
    ['isEmpty', () => [[]], () => true],
    ['isEmpty', () => [['test', 'ing']], () => false],
    ['isNull', () => ['abc'], () => false],
    ['isNull', () => [null], () => true],
    ['isBoolean', () => ['123'], () => false],
    ['isBoolean', () => [false], () => true],
    ['isString', () => ['123'], () => true],
    ['isString', () => [false], () => false],
    ['isNumber', () => ['123'], () => false],
    ['isNumber', () => [123], () => true],
    ['isNaN', () => ['123'], () => false],
    ['isNaN', () => [123], () => false],
    ['isNaN', () => [NaN], () => true],
    ['isFinite', () => ['123'], () => false],
    ['isFinite', () => [123], () => true],
    ['isFinite', () => [-Infinity], () => false],
    ['isArray', () => ['123'], () => false],
    ['isArray', () => [['123']], () => true],
    ['isObject', () => ['123'], () => false],
    ['isObject', () => [obj({ a: 123 })], () => true],
    ['isObject', () => [[123]], () => false],
    ['isFunction', () => [obj()], () => false],
    ['isFunction', () => [interpreter.eval(f, env)], () => true],
    ['isMacro', () => [obj()], () => false],
    ['isMacro', () => [interpreter.eval(f, env)], () => false],
    ['isMacro', () => [interpreter.eval(m, env)], () => true],
  ])('should return correct result for call %#: %s', (fn, args, result) => {
    const argVals = args() as AsyncValue[];
    expect(Predicates[fn as keyof typeof Predicates].apply(env, argVals as [AsyncValue])).toEqual(result());
  });
});
