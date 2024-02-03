import { describe, expect, it } from '@jest/globals';
import { CID } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { BTreeMap } from '../../impl/index.ts';
import { MaybeAsyncMap } from '../../map.ts';
import { MultiKey, compareMultiKeys } from '../multikey.ts';

describe('MultiKey', () => {
  it('should be useable as BTreeMap key with correct compare function', () => {
    const map: MaybeAsyncMap<MultiKey, number> & Iterable<[MultiKey, number]> =
      new BTreeMap<MultiKey, number>(5, compareMultiKeys);
    map.set(['a', 'c'], 5);
    map.set(['a', 'b'], 3);

    expect([...map]).toEqual([
      [['a', 'b'], 3],
      [['a', 'c'], 5],
    ]);
  });
});

describe(compareMultiKeys.name, () => {
  it.each([
    [0, 13, 13],
    [0, 'abc', 'abc'],
    [0, new Uint8Array([3, 5]), new Uint8Array([3, 5])],
    [0, CID.create(1, 0x55, identity.digest(new Uint8Array([1, 2]))), CID.create(1, 0x55, identity.digest(new Uint8Array([1, 2])))],
    [0, [], []],
    [0, [1], [1]],
    [0, [1, '2', new Uint8Array([3, 5])], [1, '2', new Uint8Array([3, 5])]],

    [1, [1], new Uint8Array([1])],
    [1, [1], 1],
    [1, [1], '1'],
    [1, new Uint8Array([1]), '1'],
    [1, CID.create(1, 0x55, identity.digest(new Uint8Array([1, 2]))), '3'],
    [1, '1', 1],
    [1, 17, 13],
    [1, 'abcd', 'abc'],
    [1, new Uint8Array([3, 6]), new Uint8Array([3, 5])],
    [1, [1, 7], [1, 3]],

    [-1, new Uint8Array([1]), [1]],
    [-1, 1, [1]],
    [-1, '1', [1]],
    [-1, '2', new Uint8Array([2])],
    [-1, 2, '2'],
    [-1, 23, 29],
    [-1, 'abc', 'abd'],
    [-1, new Uint8Array([3]), new Uint8Array([3, 5])],
    [-1, [31, 37], [37, 41]],
  ])('should return %d when comparing %j to %j', (expected: number, lhs: unknown, rhs: unknown) => {
    expect(compareMultiKeys(lhs, rhs)).toBe(expected);
  })
});
