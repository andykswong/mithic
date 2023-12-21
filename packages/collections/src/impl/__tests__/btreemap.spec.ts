import { beforeEach, describe, expect, it } from '@jest/globals';
import { RangeQueryOptions, rangeQueryable } from '../../range.js';
import { BTreeMap } from '../btreemap.js';

const ITEMS: [number, string][] = [
  [1, 'foo'],
  [2, 'bar'],
  [3, 'baz'],
  [5, 'bao'],
  [8, 'haz'],
  [13, 'das'],
  [21, 'lol'],
  [34, 'loz'],
];

describe(BTreeMap.name, () => {
  it('should initialize with an order and comparison function', () => {
    const bTree = new BTreeMap<number, string>(3);

    expect(bTree.order).toBe(3);
    expect(bTree['compare'](1, 2)).toBe(-1);
    expect(bTree['compare'](2, 1)).toBe(1);
    expect(bTree['compare'](1, 1)).toBe(0);
  });

  it('should have the correct string tag', () => {
    const bTree = new BTreeMap<number, string>();
    expect(`${bTree}`).toBe(`[object ${BTreeMap.name}]`);
  });

  it('should have correct rangeQueryable tag', () => {
    const bTree = new BTreeMap<number, string>();
    expect(bTree[rangeQueryable]).toBe(true);
  });

  describe('size', () => {
    it('should return the correct size', () => {
      const bTree = new BTreeMap<number, string>(3);

      expect(bTree.size).toBe(0);
      bTree.set(...ITEMS[0]);
      expect(bTree.size).toBe(1);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[2]);
      bTree.set(...ITEMS[3]);
      bTree.set(...ITEMS[4]);

      expect(bTree.size).toBe(5);
    });
  });

  describe('clear', () => {
    it('should clear all key-value pairs', () => {
      const bTree = new BTreeMap<number, string>(3);

      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[2]);

      bTree.clear();

      expect(bTree.size).toBe(0);
      expect(bTree.get(1)).toBeUndefined();
      expect(bTree.get(2)).toBeUndefined();
      expect(bTree.get(3)).toBeUndefined();
    });
  })

  describe('delete', () => {
    it('should delete existing key-value pairs', () => {
      const bTree = new BTreeMap<number, string>(3);

      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[2]);

      expect(bTree.delete(ITEMS[1][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.get(ITEMS[1][0])).toBe(undefined);
      expect(bTree.size).toBe(2);

      expect(bTree.delete(ITEMS[0][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.get(ITEMS[0][0])).toBe(undefined);
      expect(bTree.size).toBe(1);
    });

    it('should collapse empty nodes after delete', () => {
      const bTree = new BTreeMap<number, string>(3);
      for (const [key, value] of ITEMS) {
        bTree.set(key, value);
      }

      // deletes the root node
      expect(bTree.delete(ITEMS[3][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.get(ITEMS[3][0])).toBe(undefined);
      expect(bTree.size).toBe(ITEMS.length - 1);
    });

    it('should try to borrow elements from left sibling of deleted node', () => {
      const bTree = new BTreeMap<number, string>(3);
      for (const [key, value] of ITEMS) {
        bTree.set(key, value);
      }
      bTree.set(1.5, 'tst');

      expect(bTree.delete(ITEMS[2][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.get(ITEMS[2][0])).toBe(undefined);
      expect(bTree.size).toBe(ITEMS.length);
    });

    it('should try to borrow elements from right sibling of deleted node', () => {
      const bTree = new BTreeMap<number, string>(3);
      for (const [key, value] of ITEMS) {
        bTree.set(key, value);
      }

      expect(bTree.delete(ITEMS[4][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.get(ITEMS[4][0])).toBe(undefined);
      expect(bTree.size).toBe(ITEMS.length - 1);
    });

    it('should return false for non-existent key', () => {
      const bTree = new BTreeMap<number, string>(3);

      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[4]);

      expect(bTree.delete(3)).toBe(false);
      expect(bTree.size).toBe(3);
    });
  });

  describe('get', () => {
    it('should return stored key-value pairs', () => {
      const bTree = new BTreeMap<number, string>(3);

      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[2]);
      expectValidBTree(bTree);

      expect(bTree.get(ITEMS[0][0])).toBe(ITEMS[0][1]);
      expect(bTree.get(ITEMS[1][0])).toBe(ITEMS[1][1]);
      expect(bTree.get(ITEMS[2][0])).toBe(ITEMS[2][1]);
    });

    it('should return undefined for non-existent key', () => {
      const bTree = new BTreeMap<number, string>(3);

      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[4]);

      expect(bTree.get(3)).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return if key exists in tree', () => {
      const bTree = new BTreeMap<number, string>(3);

      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[4]);

      expect(bTree.has(ITEMS[1][0])).toBe(true);
      expect(bTree.has(ITEMS[3][0])).toBe(false);
    });
  });

  describe('set', () => {
    it('should update existing key-value pairs', () => {
      const bTree = new BTreeMap<number, string>(3);
      const newValue = 'bar';

      bTree.set(...ITEMS[0]);
      expectValidBTree(bTree);
      bTree.set(...ITEMS[1]);
      expectValidBTree(bTree);
      bTree.set(...ITEMS[2]);
      expectValidBTree(bTree);
      bTree.set(1, newValue);

      expect(bTree.get(1)).toBe(newValue);
      expect(bTree.size).toBe(3);
    });
  });

  describe('entries', () => {
    const forwardTestCases: [[number, string][], RangeQueryOptions<number>][] = [
      [ITEMS, {} as RangeQueryOptions<number>],
      [[], { lower: 8, lowerOpen: true, upper: 5 }],
      [[], { lower: 2, lowerOpen: true, upper: 2 }],
      [[], { lower: 2, upper: 2 }],
      [[], { lower: 2, lowerOpen: true, upper: 2, upperOpen: false }],
      [[], { lower: 8, upper: 22, limit: 0 }],
      [ITEMS.slice(0, 4), { upper: 8 }],
      [ITEMS.slice(0, 5), { upper: 8, upperOpen: false }],
      [ITEMS.slice(0, 3), { upper: 4, upperOpen: false }],
      [ITEMS.slice(5), { lower: 8, lowerOpen: true }],
      [ITEMS.slice(4), { lower: 8 }],
      [ITEMS.slice(5), { lower: 10 }],
      [ITEMS.slice(4, 7), { lower: 6, lowerOpen: true, upper: 22 }],
      [ITEMS.slice(4, 7), { lower: 8, upper: 22 }],
      [ITEMS.slice(4, 7), { lower: 7, lowerOpen: true, upper: 21, upperOpen: false }],
      [ITEMS.slice(4, 7), { lower: 8, upper: 21, upperOpen: false }],
      [ITEMS.slice(1, 2), { lower: 2, upper: 2, upperOpen: false }]
    ];
    const limitTestCases: [[number, string][], RangeQueryOptions<number>][] = [
      [ITEMS.slice(4, 6), { lowerOpen: true, lower: 7, upperOpen: false, upper: 21, limit: 2 }],
      [ITEMS.slice(4, 7), { lower: 8, upperOpen: false, upper: 21, limit: 10 }],
      [[ITEMS[4]], { lower: 8, upperOpen: false, upper: 21, limit: 1 }],
      [ITEMS.slice(5, 7).reverse(), { lowerOpen: true, lower: 7, upperOpen: false, upper: 21, limit: 2, reverse: true }],
      [ITEMS.slice(4, 7).reverse(), { lower: 8, upperOpen: false, upper: 21, limit: 10, reverse: true }],
      [[ITEMS[6]], { lower: 8, upperOpen: false, upper: 21, limit: 1, reverse: true }],
    ]
    const reverseTestCases: [[number, string][], RangeQueryOptions<number>][] =
      forwardTestCases.map(([items, options]) => (
        [[...items].reverse(), { ...options, reverse: true }]
      ));

    let bTree: BTreeMap<number, string>;

    beforeEach(() => {
      bTree = new BTreeMap<number, string>(3);
      for (const [key, value] of ITEMS) {
        bTree.set(key, value);
      }
    });

    it.each(forwardTestCases.concat(limitTestCases).concat(reverseTestCases))(
      'should yield %j when query option is %j',
      (items: [number, string][], options: RangeQueryOptions<number>) => {
        const entries: [number, string][] = [];
        for (const [key, value] of bTree.entries(options)) {
          entries.push([key, value]);
        }
        expect(entries).toEqual(items);
      }
    );
  });

  describe('iterators', () => {
    const items: [number, string][] = ITEMS.slice(0, 6);
    let bTree: BTreeMap<number, string>;

    beforeEach(() => {
      bTree = new BTreeMap<number, string>(3);

      bTree.set(...items[5]);
      bTree.set(...items[1]);
      bTree.set(...items[4]);
      bTree.set(...items[2]);
      bTree.set(...items[0]);
      bTree.set(...items[3]);
    });

    it('should be iterable over key-value pairs in ascending order', () => {
      const entries: [number, string][] = [];
      for (const [key, value] of bTree) {
        entries.push([key, value]);
      }
      expect(entries).toEqual(items);
    });

    test('forEach should iterate over key-value pairs in ascending order', () => {
      const entries: [number, string][] = [];
      bTree.forEach((value, key) => {
        entries.push([key, value]);
      });
      expect(entries).toEqual(items);
    });

    test('keys should iterate over keys in ascending order', () => {
      const keys: number[] = [];
      for (const key of bTree.keys()) {
        keys.push(key);
      }
      expect(keys).toEqual(items.map(([key]) => key));
    });

    test('values should iterate over values in ascending order', () => {
      const values: string[] = [];
      for (const value of bTree.values()) {
        values.push(value);
      }
      expect(values).toEqual(items.map(([, value]) => value));
    });
  });

  describe('order 2', () => {
    let bTree: BTreeMap<number, string>;

    beforeEach(() => {
      bTree = new BTreeMap<number, string>(2);
    });

    it('should construct a valid b-tree', () => {
      for (const [key, value] of ITEMS) {
        bTree.set(key, value);
      }

      expectValidBTree(bTree);
      expect(bTree.size).toBe(ITEMS.length);
      expect(bTree.get(ITEMS[4][0])).toBe(ITEMS[4][1]);
    });

    it('should maintain a valid b-tree after delete', () => {
      for (const [key, value] of ITEMS) {
        bTree.set(key, value);
      }

      expect(bTree.delete(ITEMS[4][0])).toBe(true);

      expectValidBTree(bTree);
      expect(bTree.size).toBe(ITEMS.length - 1);
      expect(bTree.has(ITEMS[4][0])).toBe(false);
    });

    it('should maintain a valid b-tree after special case delete with empty left node', () => {
      bTree.set(...ITEMS[0]);
      bTree.set(...ITEMS[1]);
      bTree.set(...ITEMS[2]);

      expect(bTree.delete(ITEMS[1][0])).toBe(true);

      expectValidBTree(bTree);
      expect(bTree.has(ITEMS[1][0])).toBe(false);
      expect(bTree.size).toBe(2);

      expect(bTree.delete(ITEMS[0][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.has(ITEMS[0][0])).toBe(false);
      expect(bTree.size).toBe(1);

      expect(bTree.delete(ITEMS[2][0])).toBe(true);
      expectValidBTree(bTree);
      expect(bTree.size).toBe(0);
    });

  });
});

function expectValidBTree<K, V>(tree: BTreeMap<K, V>, root = true): void {
  expect(tree['nodeKeys'].length).toBeLessThan(tree.order);
  if (!root && tree['nodeKeys'].length) {
    expect(tree['nodeKeys'].length).toBeGreaterThanOrEqual(Math.floor(tree.order / 2));
  }
  expect(tree['nodeValues']).toHaveLength(tree['nodeKeys'].length);

  if (tree['children'].length) {
    expect(tree['nodeKeys'].length).not.toBe(0);
    expect(tree['children']).toHaveLength(tree['nodeKeys'].length + 1);
    for (const node of tree['children']) {
      expectValidBTree(node, false);
    }
  }
}
