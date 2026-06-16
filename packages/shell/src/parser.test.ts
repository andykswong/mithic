import { expect, test } from 'vitest';
import { parse } from './parser.ts';

test('parses a two-stage pipeline', () => {
  const ast = parse('echo hi | cat');
  expect(ast.type).toBe('Program');
  const pipe = ast.body[0];
  expect(pipe.type).toBe('Pipeline');
  expect(pipe.stages).toHaveLength(2);
  expect(pipe.stages![0].name).toBe('echo');
});

test('parses output redirect', () => {
  const ast = parse('echo hi > out.txt');
  const cmd = ast.body[0].stages![0];
  expect(cmd.redirects[0]).toMatchObject({ op: '>', target: 'out.txt' });
});

test('parses variable assignment prefix', () => {
  const ast = parse('FOO=bar echo $FOO');
  expect(ast.body[0].stages![0].assignments[0]).toEqual({ name: 'FOO', value: 'bar' });
});

test('parses if/then/fi', () => {
  const ast = parse('if true; then echo yes; fi');
  expect(ast.body[0].type).toBe('If');
});

test('parses input redirect and fd-dup', () => {
  const r1 = parse('cat < in.txt').body[0].stages![0].redirects[0];
  expect(r1).toMatchObject({ op: '<', target: 'in.txt' });
  const r2 = parse('cmd 2>&1').body[0].stages![0].redirects[0];
  expect(r2).toMatchObject({ op: '>&', fd: 2, target: '1' });
  const r3 = parse('cmd 2> err').body[0].stages![0].redirects[0];
  expect(r3).toMatchObject({ op: '>', fd: 2, target: 'err' });
});

test('parses here-string', () => {
  const r = parse('cat <<< "hello"').body[0].stages![0].redirects[0];
  expect(r.op).toBe('<<<');
});

test('parses here-doc body', () => {
  const ast = parse('cat <<EOF\nline1\nline2\nEOF\n');
  const r = ast.body[0].stages![0].redirects[0];
  expect(r.op).toBe('<<');
  expect(r.hereDoc).toBe('line1\nline2\n');
});

test('parses a for loop', () => {
  const ast = parse('for x in a b c; do echo $x; done');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('For');
  expect(stmt.varName).toBe('x');
  expect(stmt.words).toEqual(['a', 'b', 'c']);
});

test('parses an until loop', () => {
  const ast = parse('until false; do echo x; done');
  expect(ast.body[0].type).toBe('While');
  expect(ast.body[0].until).toBe(true);
});

test('parses a case statement', () => {
  const ast = parse('case $x in a) echo A ;; b|c) echo BC ;; *) echo other ;; esac');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('Case');
  expect(stmt.clauses).toHaveLength(3);
  expect(stmt.clauses![1].patterns).toEqual(['b', 'c']);
});

test('parses a function definition (name() form)', () => {
  const ast = parse('greet() { echo hi; }');
  const stmt = ast.body[0];
  expect(stmt.type).toBe('Function');
  expect(stmt.funcName).toBe('greet');
  expect(stmt.funcBody).toHaveLength(1);
});

test('parses a function definition (function keyword form)', () => {
  const ast = parse('function greet { echo hi; }');
  expect(ast.body[0].type).toBe('Function');
  expect(ast.body[0].funcName).toBe('greet');
});

test('parses arithmetic command (( ))', () => {
  const ast = parse('(( x = 1 + 2 ))');
  expect(ast.body[0].type).toBe('Arithmetic');
  expect(ast.body[0].expr).toContain('x');
});

test('parses [[ conditional ]]', () => {
  const ast = parse('[[ -f foo.txt ]]');
  expect(ast.body[0].type).toBe('Cond');
  expect(ast.body[0].condWords).toEqual(['-f', 'foo.txt']);
});

test('parses background pipeline', () => {
  const ast = parse('sleep 1 &');
  expect(ast.body[0].background).toBe(true);
});

test('parses negated pipeline', () => {
  const ast = parse('! false');
  expect(ast.body[0].negate).toBe(true);
});

test('parses a subshell', () => {
  const ast = parse('( echo hi )');
  expect(ast.body[0].type).toBe('Subshell');
});
