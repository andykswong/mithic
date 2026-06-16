import { expect, test } from 'vitest';
import { evalArith } from './arith.ts';

const ev = (src: string, env: Record<string, string> = {}) => {
  const e = { ...env };
  return { value: evalArith(src, e), env: e };
};

test('basic arithmetic operators', () => {
  expect(ev('1 + 2').value).toBe(3);
  expect(ev('10 - 4').value).toBe(6);
  expect(ev('3 * 4').value).toBe(12);
  expect(ev('15 / 4').value).toBe(3); // integer division
  expect(ev('17 % 5').value).toBe(2);
  expect(ev('2 ** 10').value).toBe(1024);
});

test('precedence and parentheses', () => {
  expect(ev('2 + 3 * 4').value).toBe(14);
  expect(ev('(2 + 3) * 4').value).toBe(20);
  expect(ev('2 ** 3 ** 2').value).toBe(512); // right-assoc
});

test('bitwise and shift', () => {
  expect(ev('6 & 3').value).toBe(2);
  expect(ev('6 | 1').value).toBe(7);
  expect(ev('6 ^ 3').value).toBe(5);
  expect(ev('~0').value).toBe(-1);
  expect(ev('1 << 4').value).toBe(16);
  expect(ev('256 >> 2').value).toBe(64);
});

test('comparison and logical operators', () => {
  expect(ev('3 < 5').value).toBe(1);
  expect(ev('5 < 3').value).toBe(0);
  expect(ev('3 <= 3').value).toBe(1);
  expect(ev('4 == 4').value).toBe(1);
  expect(ev('4 != 4').value).toBe(0);
  expect(ev('1 && 0').value).toBe(0);
  expect(ev('1 || 0').value).toBe(1);
  expect(ev('!0').value).toBe(1);
  expect(ev('!5').value).toBe(0);
});

test('ternary', () => {
  expect(ev('1 ? 10 : 20').value).toBe(10);
  expect(ev('0 ? 10 : 20').value).toBe(20);
});

test('variables resolve from env (bare names)', () => {
  expect(ev('x + 1', { x: '41' }).value).toBe(42);
  expect(ev('$x + 1', { x: '41' }).value).toBe(42);
  expect(ev('unset + 5').value).toBe(5); // unset → 0
});

test('assignment mutates env and returns value', () => {
  const r = ev('x = 7', {});
  expect(r.value).toBe(7);
  expect(r.env.x).toBe('7');
});

test('compound assignment', () => {
  const r = ev('x += 3', { x: '5' });
  expect(r.value).toBe(8);
  expect(r.env.x).toBe('8');
});

test('pre/post increment and decrement', () => {
  const r1 = ev('++x', { x: '5' });
  expect(r1.value).toBe(6);
  expect(r1.env.x).toBe('6');
  const r2 = ev('x++', { x: '5' });
  expect(r2.value).toBe(5);
  expect(r2.env.x).toBe('6');
  const r3 = ev('x--', { x: '5' });
  expect(r3.value).toBe(5);
  expect(r3.env.x).toBe('4');
});

test('comma operator returns last', () => {
  expect(ev('1, 2, 3').value).toBe(3);
});

test('hex and octal literals', () => {
  expect(ev('0xff').value).toBe(255);
  expect(ev('010').value).toBe(8);
});
