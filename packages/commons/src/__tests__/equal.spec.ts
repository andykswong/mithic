import { describe, expect, it } from '@jest/globals';
import { StringEquatable, equalsOrSameString } from '../equal.js';

class WithEqual implements StringEquatable<WithEqual> {
  constructor(public value: string) {}

  equals(rhs: WithEqual) {
    return this.value === rhs.value;
  }
}

const OBJ = { a: 1 };

describe('equals', () => {
  it.each([
    [true, 'receiving same objects', OBJ, OBJ],
    [true, 'receiving 2 equal strings', 'str', 'str'],
    [false, 'receiving 2 different strings', 'str1', 'str2'],
    [true, 'lhs.equals(rhs) is true', new WithEqual('abc'), new WithEqual('abc')],
    [false, 'lhs.equals(rhs) is false', new WithEqual('abc'), new WithEqual('def')],
  ])('should return %s when %s', (result, _, lhs: StringEquatable, rhs: StringEquatable) => {
    expect(equalsOrSameString(lhs, rhs)).toBe(result);
  });
});
