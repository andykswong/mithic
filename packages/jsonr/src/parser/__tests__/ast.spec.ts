import { beforeEach, describe, expect, it } from '@jest/globals';
import { JsonAstParser } from '../ast.ts';
import { symAsync, symFn, symFnArgs, symFnBody, symMacro } from '../../symbol.ts';
import { FnValue } from '../../types.ts';

describe(JsonAstParser.name, () => {
  let parser: JsonAstParser;

  beforeEach(() => {
    parser = new JsonAstParser();
  });

  describe('parse', () => {
    it('should parse JSON into object of null prototype', () => {
      const ast = parser.parse('{"a":1}');
      expect(ast).toEqual({ a: 1 });
      expect(Object.getPrototypeOf(ast)).toBe(null);
    });

    it('should parse quoted strings', () => {
      const ast = parser.parse('["+","\'test","ing"]');
      expect(ast).toEqual(['+', ['\'', 'test'], 'ing']);
    });

    it('should parse unquoted strings', () => {
      const ast = parser.parse('["`",[",test","ing"]]');
      expect(ast).toEqual(['`', [[',', 'test'], 'ing']]);
    });
  });

  describe('print', () => {
    it('should print compact quoted strings', () => {
      const str = parser.print(['+', ['\'', 'test'], 'ing']);
      expect(str).toEqual('["+","\'test","ing"]');
    });

    it('should print compact unquoted strings', () => {
      const str = parser.print(['`', [[',', 'test'], 'ing']]);
      expect(str).toEqual('["`",[",test","ing"]]');
    });

    it('should print native function by name', () => {
      const f1 = () => true;
      const str = parser.print([f1, () => null]);
      expect(str).toEqual('["f1","fn#anonymous"]');
    });

    it('should print user function or macro by their definition', () => {
      const f1: FnValue = () => true;
      f1[symFn] = true as const;
      f1[symFnBody] = ['+', '3', '4'];
      const f2: FnValue = () => true;
      f2[symFn] = true as const;
      f2[symAsync] = true as const;
      f2[symFnArgs] = ['c', 'd'];
      f2[symFnBody] = ['-', 'c', 'd'];
      const m1: FnValue = () => true;
      m1[symFn] = true as const;
      m1[symMacro] = true as const;
      m1[symFnArgs] = ['b'];
      m1[symFnBody] = ['!', 'b'];

      const str = parser.print([f1, f2, m1]);
      expect(str).toEqual('[["fn",[],["+","3","4"]],["async",["c","d"],["-","c","d"]],["macro",["b"],["!","b"]]]');
    });

    it('should print promise as empty object', () => {
      const str = parser.print([Promise.resolve(123)]);
      expect(str).toEqual('[{}]');
    });

    it('should print numbers correctly', () => {
      const str = parser.print([1.2, 3, NaN, +Infinity, -Infinity]);
      expect(str).toEqual('[1.2,3,["+","NaN"],["+","Infinity"],["-","Infinity"]]');
    });
  });
});
