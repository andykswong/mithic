import { describe, expect, it } from '@jest/globals';
import { assertArray, assertFunction, assertString, assertStrings, isFunction, isObj, isString, obj } from '../utils.ts';
import { AsyncValue } from '../types.ts';

describe(assertString.name, () => {
  it('should not throw if value is a string', () => {
    expect(() => assertString('foo')).not.toThrow();
  });

  it.each([
    [null], [123], [true], [['a']], [{ a: 1 }], Promise.resolve('a')
  ])('should throw if value = $p', (value: AsyncValue) => {
    expect(() => assertString(value)).toThrow(SyntaxError);
  });
});

describe(assertArray.name, () => {
  it('should not throw if value is an array', () => {
    expect(() => assertArray([])).not.toThrow();
    expect(() => assertArray(['a', 'b'])).not.toThrow();
    expect(() => assertArray([Promise.resolve('a')])).not.toThrow();
  });

  it.each([
    [null], [123], [true], [{ a: 1 }], ['abc']
  ])('should throw if value = $p', (value: AsyncValue) => {
    expect(() => assertArray(value)).toThrow(SyntaxError);
  });
});

describe(assertStrings.name, () => {
  it('should not throw if value is a string array', () => {
    expect(() => assertStrings([])).not.toThrow();
    expect(() => assertStrings(['a', 'b'])).not.toThrow();
  });

  it.each([
    [null], [123], [true], [{ a: 1 }], ['abc'],
    [[123]], [['abc', 123]], [Promise.resolve('a')]
  ])('should throw if value = $p', (value: AsyncValue) => {
    expect(() => assertStrings(value)).toThrow(SyntaxError);
  });
});

describe(assertFunction.name, () => {
  it('should not throw if value is a function', () => {
    expect(() => assertFunction(() => true)).not.toThrow();
  });

  it.each([
    [null], [123], [true], [['a']], [{ a: 1 }], ['abc'], Promise.resolve(() => true)
  ])('should throw if value = $p', (value: AsyncValue) => {
    expect(() => assertFunction(value)).toThrow(TypeError);
  });
});

describe(isString.name, () => {
  it('should return true if value is a string', () => {
    expect(isString('foo')).toBe(true);
  });

  it.each([
    [null], [123], [true], [['a']], [{ a: 1 }], Promise.resolve('a')
  ])('should return false if value = $p', (value: AsyncValue) => {
    expect(isString(value)).toBe(false);
  });
});

describe(isFunction.name, () => {
  it('should return true if value is a function', () => {
    expect(isFunction(() => true)).toBe(true);
  });

  it.each([
    [null], [123], [true], [['a']], [{ a: 1 }], ['abc'], Promise.resolve(() => true)
  ])('should return false if value = $p', (value: AsyncValue) => {
    expect(isFunction(value)).toBe(false);
  });
});

describe(isObj.name, () => {
  it('should return true if value is an object with null prototype', () => {
    expect(isObj(Object.create(null))).toBe(true);
  });

  it.each([
    [null], [123], [true], [['a']], [{ a: 1 }], ['abc'], Promise.resolve(Object.create(null))
  ])('should return false if value = $p', (value: AsyncValue) => {
    expect(isObj(value)).toBe(false);
  });
});

describe(obj.name, () => {
  it('should return a santized version of given object', () => {
    const input = { a: 1, b: 2, c: 3 };
    const output = obj(input);
    expect(output).toEqual(input);
    expect(Object.getPrototypeOf(output)).toBe(null);
  });
});
