import { expect, test, describe } from 'vitest';
import { parseProgram } from './parser.ts';
import type { Expr, Stmt, Rule } from './ast.ts';

/** Parse a program and return its rules. */
function rules(src: string): Rule[] { return parseProgram(src).rules; }
/** Parse a single-action program `{ ... }` and return its statements. */
function stmts(src: string): Stmt[] { return rules(`{ ${src} }`)[0].action!; }
/** Parse a single expression statement and return its expression. */
function expr(src: string): Expr {
  const s = stmts(src + ';')[0];
  if (s.type !== 'expr') throw new Error('not an expr stmt: ' + s.type);
  return s.expr;
}

describe('awk parser — rules & patterns', () => {
  test('BEGIN and END blocks', () => {
    const r = rules('BEGIN { x = 1 } END { print x }');
    expect(r[0].pattern.type).toBe('begin');
    expect(r[1].pattern.type).toBe('end');
  });

  test('action-only rule', () => {
    expect(rules('{ print }')[0].pattern.type).toBe('always');
  });

  test('pattern-only rule has no action', () => {
    const r = rules('/foo/');
    expect(r[0].pattern.type).toBe('expr');
    expect(r[0].action).toBeUndefined();
  });

  test('expression pattern with action', () => {
    const r = rules('$1 > 5 { print $2 }');
    expect(r[0].pattern.type).toBe('expr');
    expect(r[0].action![0].type).toBe('print');
  });

  test('range pattern', () => {
    const r = rules('/a/,/b/ { print }');
    expect(r[0].pattern).toMatchObject({ type: 'range' });
  });

  test('regex pattern is a regex expression', () => {
    const r = rules('/x.y/');
    expect(r[0].pattern).toMatchObject({ type: 'expr', expr: { type: 'regex', source: 'x.y' } });
  });
});

describe('awk parser — functions', () => {
  test('function definition with params', () => {
    const p = parseProgram('function add(a, b) { return a + b }');
    const fn = p.functions.get('add')!;
    expect(fn.params).toEqual(['a', 'b']);
    expect(fn.body[0].type).toBe('return');
  });

  test('function call expression', () => {
    expect(expr('f(1, 2)')).toMatchObject({ type: 'call', name: 'f', args: [{}, {}] });
  });
});

describe('awk parser — expressions & precedence', () => {
  test('arithmetic precedence: * binds tighter than +', () => {
    expect(expr('1 + 2 * 3')).toMatchObject({
      type: 'binary', op: '+',
      right: { type: 'binary', op: '*' },
    });
  });

  test('power is right-associative', () => {
    expect(expr('2 ^ 3 ^ 2')).toMatchObject({
      type: 'binary', op: '^',
      right: { type: 'binary', op: '^' },
    });
  });

  test('unary minus', () => {
    expect(expr('-x')).toMatchObject({ type: 'unary', op: '-' });
  });

  test('concatenation by juxtaposition', () => {
    expect(expr('"a" "b" "c"')).toMatchObject({ type: 'concat', parts: [{}, {}, {}] });
  });

  test('concat binds looser than +', () => {
    // `a b + c` → concat(a, (b + c))
    expect(expr('a b + c')).toMatchObject({
      type: 'concat',
      parts: [{ type: 'var', name: 'a' }, { type: 'binary', op: '+' }],
    });
  });

  test('comparison', () => {
    expect(expr('a < b')).toMatchObject({ type: 'binary', op: '<' });
  });

  test('match operators', () => {
    expect(expr('$0 ~ /re/')).toMatchObject({ type: 'binary', op: '~' });
    expect(expr('x !~ /re/')).toMatchObject({ type: 'binary', op: '!~' });
  });

  test('logical and/or', () => {
    expect(expr('a && b || c')).toMatchObject({
      type: 'binary', op: '||',
      left: { type: 'binary', op: '&&' },
    });
  });

  test('ternary', () => {
    expect(expr('a ? b : c')).toMatchObject({ type: 'ternary' });
  });

  test('assignment is right-associative', () => {
    expect(expr('a = b = 1')).toMatchObject({
      type: 'assign', op: '=',
      value: { type: 'assign', op: '=' },
    });
  });

  test('compound assignment', () => {
    expect(expr('x += 2')).toMatchObject({ type: 'assign', op: '+=' });
  });

  test('field references', () => {
    expect(expr('$0')).toMatchObject({ type: 'field', index: { type: 'num', value: 0 } });
    expect(expr('$NF')).toMatchObject({ type: 'field', index: { type: 'var', name: 'NF' } });
    expect(expr('$(NF-1)')).toMatchObject({ type: 'field' });
  });

  test('pre and post increment', () => {
    expect(expr('++i')).toMatchObject({ type: 'update', op: '++', prefix: true });
    expect(expr('i++')).toMatchObject({ type: 'update', op: '++', prefix: false });
  });

  test('array index and multidim', () => {
    expect(expr('a[i]')).toMatchObject({ type: 'index', name: 'a', indices: [{}] });
    expect(expr('a[i, j]')).toMatchObject({ type: 'index', name: 'a', indices: [{}, {}] });
  });

  test('in operator', () => {
    expect(expr('k in a')).toMatchObject({ type: 'in', array: 'a' });
    expect(expr('(i, j) in a')).toMatchObject({ type: 'in', array: 'a', indices: [{}, {}] });
  });

  test('builtin calls', () => {
    expect(expr('length($0)')).toMatchObject({ type: 'builtin', name: 'length' });
    expect(expr('length')).toMatchObject({ type: 'builtin', name: 'length', args: [] });
    expect(expr('substr(s, 1, 3)')).toMatchObject({ type: 'builtin', name: 'substr', args: [{}, {}, {}] });
  });
});

describe('awk parser — statements', () => {
  test('if/else', () => {
    const s = stmts('if (x) print 1; else print 2')[0];
    expect(s).toMatchObject({ type: 'if', else: { type: 'print' } });
  });

  test('while loop', () => {
    expect(stmts('while (i < 10) i++')[0].type).toBe('while');
  });

  test('do-while loop', () => {
    expect(stmts('do x++; while (x < 3)')[0].type).toBe('dowhile');
  });

  test('c-style for', () => {
    expect(stmts('for (i = 0; i < n; i++) print i')[0]).toMatchObject({ type: 'for' });
  });

  test('for-in', () => {
    expect(stmts('for (k in a) print k')[0]).toMatchObject({ type: 'forin', var: 'k', array: 'a' });
  });

  test('print with redirect', () => {
    const s = stmts('print x > "file"')[0];
    expect(s).toMatchObject({ type: 'print', redirect: { mode: '>' } });
  });

  test('print with append redirect', () => {
    expect(stmts('print x >> "f"')[0]).toMatchObject({ type: 'print', redirect: { mode: '>>' } });
  });

  test('print with pipe redirect', () => {
    expect(stmts('print x | "cmd"')[0]).toMatchObject({ type: 'print', redirect: { mode: '|' } });
  });

  test('printf with format and args', () => {
    expect(stmts('printf "%d\\n", x')[0]).toMatchObject({ type: 'printf', args: [{}, {}] });
  });

  test('print comparison still works inside parens', () => {
    // `print (a > b)` — `>` inside the group is a comparison, not a redirect.
    const s = stmts('print (a > b)')[0];
    expect(s).toMatchObject({ type: 'print' });
    expect((s as { redirect?: unknown }).redirect).toBeUndefined();
  });

  test('parenthesized printf argument list', () => {
    // `printf("%d %d\n",1,2)` — the parens wrap the whole arg list.
    expect(stmts('printf("%d %d\\n",1,2)')[0])
      .toMatchObject({ type: 'printf', args: [{}, {}, {}] });
  });

  test('parenthesized print argument list', () => {
    expect(stmts('print(a,b)')[0]).toMatchObject({ type: 'print', args: [{}, {}] });
  });

  test('parenthesized list still allows (a,b) in arr', () => {
    expect(expr('(a, b) in arr')).toMatchObject({ type: 'in', array: 'arr' });
  });

  test('delete element and whole array', () => {
    expect(stmts('delete a[i]')[0]).toMatchObject({ type: 'delete', name: 'a', indices: [{}] });
    expect(stmts('delete a')[0]).toMatchObject({ type: 'delete', name: 'a' });
  });

  test('next, nextfile, break, continue, exit, return', () => {
    expect(stmts('next')[0].type).toBe('next');
    expect(stmts('nextfile')[0].type).toBe('nextfile');
    expect(stmts('break')[0].type).toBe('break');
    expect(stmts('continue')[0].type).toBe('continue');
    expect(stmts('exit 2')[0]).toMatchObject({ type: 'exit', code: { type: 'num', value: 2 } });
    expect(rules('function f() { return 5 }')).toEqual([]);
  });

  test('getline forms', () => {
    expect(expr('getline')).toMatchObject({ type: 'getline', source: 'main' });
    expect(expr('getline x')).toMatchObject({ type: 'getline', source: 'main', into: { type: 'var', name: 'x' } });
    expect(expr('getline < "file"')).toMatchObject({ type: 'getline', source: 'file' });
    expect(expr('"cmd" | getline')).toMatchObject({ type: 'getline', source: 'cmd' });
    expect(expr('"cmd" | getline line')).toMatchObject({ type: 'getline', source: 'cmd', into: { type: 'var', name: 'line' } });
  });

  test('statements separated by newlines', () => {
    expect(stmts('x = 1\ny = 2\nprint x').length).toBe(3);
  });
});
