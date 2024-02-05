import { beforeEach, describe, expect, it } from '@jest/globals';
import { DefaultEnv } from '../../env.ts';
import { Stdlib } from '../../stdlib/index.ts';
import { Env, JSONType } from '../../types.ts';
import { obj } from '../../utils.ts';
import { Interpreter } from '../interpreter.ts';

describe(Interpreter.name, () => {
  let env: Env;
  let interpreter: Interpreter;

  beforeEach(() => {
    env = new DefaultEnv(null, {
      ...Stdlib,
      unreachable: () => { throw new Error('unreachable'); },
      promise: (x) => Promise.resolve(x)
    });
    interpreter = new Interpreter();
  });

  describe('compile', () => {
    it('should return a function for running given AST', () => {
      const f = interpreter.compile<[number]>(['+', 'n', 3], ['n']);
      expect(f.call(env, 2)).toBe(5);
    });

    it('should support no-arg function', () => {
      const f = interpreter.compile(['+', 2, 3]);
      expect(f.call(env)).toBe(5);
    });

  });

  describe('eval', () => {
    it.each([
      [], obj(), 0, -12, false, true, null
    ])('should return literals as is %#', (expr) => {
      expect(run(expr)).toEqual(expr);
    });

    it.each([
      [['[]', 1, ['+', 2, 3], true, ['\'', 'abc']], [1, 5, true, 'abc']],
      [obj({ a: ['+', 3, 5], b: ['\'', '123'] }), obj({ a: 8, b: '123' })],
      [['/', ['-', ['+', 515, ['*', 87, 311]], 302], 27], 1010],
    ])('should evaluate expressions correctly %#', (expr, expected) => {
      expect(run(expr)).toEqual(expected);
    });

    it('should get and set variables correctly', () => {
      expect(run(['let', 'x', 3, 'y', 4])).toEqual(4);
      expect(run(obj({ x: 'x', y: 'y' }))).toEqual(obj({ x: 3, y: 4 }));

      expect(run(['let', 'z', 5, 'z', 6])).toEqual(6);
      expect(run('z')).toEqual(6);

      expect(run(['let', 'a', 7])).toEqual(7);
      expect(run(['let', 'A', 8])).toEqual(8);
      expect(run('a')).toEqual(7);
      expect(run(['@', ['\'', 'A']])).toEqual(8);
    });

    it.each(['let', 'const', '='])('should support destructuring assignment with `%s`', (keyword) => {
      run(['let', 'x', 0, 'y', 1]);
      expect(run([keyword, ['x', 'y'], ['[]', 3, 4]])).toEqual([3, 4]);
      expect(run('x')).toEqual(3);
      expect(run('y')).toEqual(4);
    });

    it('should define and call functions correctly', () => {
      expect(run(['let', 'x', 3, 'y', 4, 'z', 5])).toEqual(5);
      expect(run(['fn', 'xyz', ['z', 'aa'], ['[]', 'x', 'y', 'z', 'aa']])).toBeInstanceOf(Function);
      expect(run(['xyz', 6])).toEqual([3, 4, 6, null]);
      expect(run('z')).toEqual(5);
      expect(run(['apply', 'xyz', ['[]', 7, 11]])).toEqual([3, 4, 7, 11]);
      expect(run(['apply', 'xyz', ['[]', 8]])).toEqual([3, 4, 8, null]);
      expect(run(['let', 'f', ['fn', ['x'], 'x']])).toBeInstanceOf(Function);
      expect(run(['f', 7])).toEqual(7);
    });

    it('should abide variable scope', () => {
      expect(run(['let', 'x', 3])).toEqual(3);
      expect(run(['{}', ['let', 'x', 4], 'x'])).toEqual(4);
      expect(run('x')).toEqual(3);
      expect(run(['{}', ['=', 'x', 4], 'x'])).toEqual(4);
      expect(run('x')).toEqual(4);
    });

    it('should throw for invalid references', () => {
      expect(run(['let', 'x', 3])).toEqual(3);
      expect(() => run(['x'])).toThrow(new TypeError('x is not a function'));
      expect(() => run(['xyz'])).toThrow(new TypeError('xyz is not defined'));
      expect(() => run([['@', ['\'', 'xyz']]])).toThrow(new ReferenceError('xyz is not defined'));
    });

    it.each([
      [['if', ['>', 3, 2], 200, ['unreachable']], 200],
      [['if', ['boolean', true], 200], 200],
      [[';', ['let', 'n', 0], ['while', ['<', 'n', 10], ['=', 'n', ['+', 1, 'n']]]], 10],
      [[';', ['let', 'n', 0], ['for', 'x', ['[]', 1, 3, 5], ['=', 'n', ['+', 'x', 'n']]]], 9],
      [['try', 200, ['catch', ['unreachable']]], 200],
      [['try', ['throw', 'exception'], ['catch', 'msg', ['+', ['\'', 'caught: '], 'msg']]], 'caught: exception'],
    ])('should evaluate control expressions correctly %#', (expr, expected) => {
      expect(run(expr)).toEqual(expected);
    });

    it.each([
      [['if', ['&&'], ['unreachable'], 200], 200],
      [['if', ['||', false, false], ['unreachable']], null],
      [['if', ['&&', true, false, ['unreachable']], ['unreachable'], 200], 200],
      [['if', ['||', false, true, ['unreachable']], 200], 200],
      [['??', 200, ['unreachable']], 200]
    ])('should short circuit evaluate correctly %#', (expr, expected) => {
      expect(run(expr)).toEqual(expected);
    });

    it.each([
      [['if', ['&', true, false, ['unreachable']], 'never']],
      [['if', ['|', false, true, ['unreachable']], 'never']],
    ])('should eager evaluate and throw %#', (expr) => {
      expect(() => run(expr)).toThrow('unreachable');
    });

    it('should throw error from throw expression', () => {
      expect(() => run(['throw'])).toThrow();
      expect(() => run(['throw', 'error'])).toThrow('error');
    });

    const sumTR = ['fn', 'sum-tr', ['n', 'acc'],
      ['if', ['===', 'n', 0], 'acc', [';',
        ['=', 'acc', ['+', 'n', 'acc']],
        ['sum-tr', ['-', 'n', 1], 'acc'],
      ]]
    ];
    const recurseA = ['fn', 'recurse-a', ['n'], ['if', ['<=', 'n', 0], 0, ['recurse-b', ['-', 'n', 1]]]];
    const recurseB = ['fn', 'recurse-b', ['n'], ['if', ['>=', 0, 'n'], 0, ['recurse-a', ['-', 'n', 2]]]];

    it.each([
      [[sumTR, 10], 55],
      [[sumTR, 10000], 50005000],
      [[';', recurseB, recurseA, [recurseA[1], 10000]], 0],
    ])('should evaluate recursive tail-call functions correctly %#', (expr, expected) => {
      expect(run(expr)).toEqual(expected);
    });

    it('should evaluate async functions synchronously when without await', () => {
      expect(run(['async', 'echo', ['n'], 'n'])).toBeInstanceOf(Function);
      expect(run(['echo', 1])).toBe(1);
    });

    it('should return promise for async functions results', async () => {
      expect(run(['async', 'next', ['x'], ['+', 1, ['await', ['promise', 'x']]]])).toBeInstanceOf(Function);
      await expect(run(['next', 1])).resolves.toBe(2);
    });

    it('should be awaitable at global scope', async () => {
      await expect(run(['+', 1, ['await', ['promise', 1]]])).resolves.toBe(2);
    });

    it('should throw when using await in sync fn', () => {
      expect(run(['fn', 'wait', ['x'], ['await', 'x']])).toBeInstanceOf(Function);
      expect(() => run(['wait', 1])).toThrow(new SyntaxError('await is only valid in async scope'));
    });

    it.each([
      [[';', ['const', 'x', 2], ['let', 'x', 3]]],
      [[';', ['const', 'x', 2], ['=', 'x', 3]]],
    ])('should throw when reassigning consts', (expr: JSONType) => {
      expect(() => run(expr)).toThrow(/Cannot assign/);
    });

    it.each([
      [['\''], null],
      [['\'', 'x'], 'x'],
      [['\'', 7], 7],
      [['\'', [1, ['-', 2, 3]]], [1, ['-', 2, 3]]],
      [['\'', obj({ a: ['+', 3, 4] })], obj({ a: ['+', 3, 4] })],
      [['`'], null],
      [['`', 'x'], 'x'],
      [['`', [1, [], 2]], [1, [], 2]],
      [['`', obj({ a: ['+', 3, 4] })], obj({ a: ['+', 3, 4] })],
      [['`', [',', 7]], 7],
      [['`', [',', 'x']], 1],
      [['`', ['+', 3, [',', 'x']]], ['+', 3, 1]],
      [['`', [3, [',', ['+', 'x', 'x']], [',', 'x']]], [3, 2, 1]],
      [['`', [3, [',@', ['[]', 'x', 'x']], [',', 'x']]], [3, 1, 1, 1]],
      [['`', obj({ a: ['+', 3, 4], b: [',', ['+', 5, 6]] })], obj({ a: ['+', 3, 4], b: 11 })],
    ])('should return quoted / quasiquoted results %#', (expr, expected) => {
      run(['let', 'x', 1]);
      expect(run(expr)).toEqual(expected);
    });

    it.each([
      [['macro', 'one', [], 1], ['one'], 1, 1],
      [[';', ['let', 'a', 123], ['macro', 'identity', ['x'], 'x']], ['identity', 'a'], 'a', 123],
      [
        ['macro', 'unless', ['pred', 'a', 'b'], ['`', ['if', [',', 'pred'], [',', 'b'], [',', 'a']]]],
        ['unless', ['&&', true, false], 7, 8], ['if', ['&&', true, false], 8, 7], 7
      ],
      [
        ['macro', 'unless2', ['pred', 'a', 'b'], ['[]', ['\'', 'if'], ['[]', ['\'', '!'], 'pred'], 'a', 'b']],
        ['unless2', true, 7, 8], ['if', ['!', true], 7, 8], 8
      ],
      [
        ['macro', 'cond', ['test', 'action', '...xs'],
          ['[]', ['\'', 'if'], 'test', 'action', ['if', ['>', ['length', 'xs'], 0], ['...', ['\'', 'cond'], 'xs'], null]]
        ],
        [';', ['let', 'x', ['cond', false, 404, true, 200]], 'x'],
        undefined,
        200
      ]
    ])('should expand and run macro correctly %#', (macro, call, expanded, result) => {
      expect(run(macro)).toBeInstanceOf(Function);
      expanded !== undefined && expect(run(['macroexpand', call])).toEqual(expanded);
      expect(run(call)).toEqual(result);
    });
  });

  function run(expr: JSONType, _env: Env = env) {
    return interpreter.eval(expr, _env);
  }
});
