import { expect, test } from 'vitest';
import { evalArith } from './arith.ts';

test('division by zero throws', () => {
  expect(() => evalArith('1/0', {})).toThrow(/division by 0|divide/i);
});

test('modulo by zero throws', () => {
  expect(() => evalArith('5%0', {})).toThrow(/division by 0|divide/i);
});

test('/= by zero throws', () => {
  expect(() => evalArith('x/=0', { x: '4' })).toThrow(/division by 0|divide/i);
});

test('normal division still truncates toward zero', () => {
  expect(evalArith('7/2', {})).toBe(3);
  expect(evalArith('-7/2', {})).toBe(-3);
});
