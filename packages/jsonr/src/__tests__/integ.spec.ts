import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DefaultEnv } from '../env.ts';
import { Interpreter } from '../interpreter/index.ts';
import { JsonAstParser } from '../parser/index.ts';
import { Stdlib } from '../stdlib/index.ts';
import { AsyncValue, Env, Evaluator, JSONType, Parser } from '../types.ts';

import asyncTest from './data/async.json';
import macroTest from './data/macro.json';

describe('Integration tests', () => {
  let env: Env;
  let evaluator: Evaluator;
  let parser: Parser;
  let lines: AsyncValue[][];
  let readline: jest.Mock<(prompt: string, timeout?: number) => Promise<string>>;

  beforeEach(() => {
    env = new DefaultEnv(null, {
      ...Stdlib,
      println: (...args: AsyncValue[]) => (lines.push(args), null),
      readline: (...args: AsyncValue[]) => readline(...args as [string, number?]),
    });
    evaluator = new Interpreter();
    parser = new JsonAstParser();
    lines = [];
    readline = jest.fn();
  });

  describe('macro', () => {
    it('should print the correct results', async () => {
      const code = JSON.stringify(macroTest);
      const ast = parser.parse(code);
      const result = await evaluator.eval(ast, env);
      expect(result).toBe(null);
      expect(lines).toMatchSnapshot();
    });
  });

  describe('async', () => {
    let ast: JSONType;

    beforeEach(() => {
      const code = JSON.stringify(asyncTest);
      ast = parser.parse(code);
    });

    it('should print the correct results', async () => {
      const input = 'testing';
      readline.mockResolvedValueOnce(input);
      const result = await evaluator.eval(ast, env);
      expect(result).toBe(null);
      expect(lines).toMatchSnapshot();
      expect(readline).toHaveBeenCalledWith('your input: ', 2000);
    });

    it('should catch rejected promise from readline', async () => {
      readline.mockRejectedValueOnce(new Error('aborted'));
      const result = await evaluator.eval(ast, env);
      expect(result).toBe(null);
      expect(lines).toMatchSnapshot();
    });
  });
});
