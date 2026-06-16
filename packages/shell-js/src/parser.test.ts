import { expect, test } from 'vitest';
import { parse } from './parser.ts';

test('parses a two-stage pipeline', () => {
  const ast = parse('echo hi | cat');
  expect(ast.type).toBe('Program');
  const pipe = ast.body[0];
  expect(pipe.type).toBe('Pipeline');
  expect(pipe.stages).toHaveLength(2);
  expect(pipe.stages[0].name).toBe('echo');
});

test('parses output redirect', () => {
  const ast = parse('echo hi > out.txt');
  const cmd = ast.body[0].stages[0];
  expect(cmd.redirects[0]).toMatchObject({ op: '>', target: 'out.txt' });
});

test('parses variable assignment prefix', () => {
  const ast = parse('FOO=bar echo $FOO');
  expect(ast.body[0].stages[0].assignments[0]).toEqual({ name: 'FOO', value: 'bar' });
});

test('parses if/then/fi', () => {
  const ast = parse('if true; then echo yes; fi');
  expect(ast.body[0].type).toBe('If');
});
