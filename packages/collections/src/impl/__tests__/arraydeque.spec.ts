import { beforeEach, describe, expect, it, test } from '@jest/globals';
import { ArrayDeque } from '../arraydeque.ts';

describe(ArrayDeque.name, () => {
  let deque: ArrayDeque<number>;

  beforeEach(() => {
    deque = new ArrayDeque<number>(3);
  });

  it('should have correct string tag', () => {
    expect(`${deque}`).toBe(`[object ${ArrayDeque.name}]`);
  });

  describe('size', () => {
    test('returns the size of the deque', () => {
      expect(deque.size).toBe(0);
      deque.unshift(1);
      deque.push(2);
      expect(deque.size).toBe(2);
      deque.shift();
      expect(deque.size).toBe(1);
      deque.pop();
      expect(deque.size).toBe(0);
    });
  });

  describe('capacity', () => {
    test('returns the capacity of the deque', () => {
      expect(deque.capacity).toBe(3);
      deque.unshift(1);
      deque.push(2);
      deque.push(3);
      deque.push(4);
      expect(deque.capacity).toBe(6);
    });
  });

  describe('front', () => {
    test('returns undefined when deque is empty', () => {
      expect(deque.front()).toBeUndefined();
    });

    test('returns the front element without removing it', () => {
      deque.push(1);
      deque.push(2);
      expect(deque.front()).toBe(1);
      expect(deque.size).toBe(2);
    });
  });

  describe('back', () => {
    test('returns undefined when deque is empty', () => {
      expect(deque.back()).toBeUndefined();
    });

    test('returns the rear element without removing it', () => {
      deque.push(1);
      deque.push(2);
      expect(deque.back()).toBe(2);
      expect(deque.size).toBe(2);
    });
  });

  describe('get', () => {
    it('should return undefined for an empty deque', () => {
      expect(deque.get(0)).toBeUndefined();
    });

    it('should return undefined for out-of-bounds indices', () => {
      deque.push(1);
      deque.push(2);
      expect(deque.get(-1)).toBeUndefined();
      expect(deque.get(2)).toBeUndefined();
    });

    it('should return the correct element', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.get(0)).toBe(1);
      expect(deque.get(1)).toBe(2);
      expect(deque.get(2)).toBe(3);
    });
  });

  describe('has', () => {
    it('should return false for out-of-bounds indices', () => {
      deque.push(1);
      deque.push(2);
      expect(deque.has(-1)).toBe(false);
      expect(deque.has(2)).toBe(false);
    });

    it('should return true for existing element', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.has(0)).toBe(true);
      expect(deque.has(1)).toBe(true);
      expect(deque.has(2)).toBe(true);
    });
  });

  describe('clear', () => {
    test('clears all elements from the deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.size).toBe(3);
      deque.clear();
      expect(deque.size).toBe(0);
      expect(deque.front()).toBeUndefined();
      expect(deque.back()).toBeUndefined();
    });
  });

  describe('unshift', () => {
    test('adds an element to the front of an empty deque', () => {
      deque.unshift(1);
      expect(deque.size).toBe(1);
      expect(deque.front()).toBe(1);
      expect(deque.back()).toBe(1);
    });

    test('adds an element to the front of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.unshift(3);
      expect(deque.size).toBe(3);
      expect(deque.front()).toBe(3);
      expect(deque.back()).toBe(2);
    });

    test('resizes the deque if it is full', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      deque.unshift(4);
      expect(deque.size).toBe(4);
      expect(deque.capacity).toBe(6);
      expect(deque.front()).toBe(4);
      expect(deque.back()).toBe(3);
    });
  });

  describe('shift', () => {
    test('returns undefined when deque is empty', () => {
      expect(deque.shift()).toBeUndefined();
    });

    test('removes an element from the front of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.shift()).toBe(1);
      expect(deque.size).toBe(2);
      expect(deque.front()).toBe(2);
      expect(deque.back()).toBe(3);
    });

    test('removes the last element from the deque', () => {
      deque.push(1);
      expect(deque.shift()).toBe(1);
      expect(deque.size).toBe(0);
      expect(deque.front()).toBeUndefined();
      expect(deque.back()).toBeUndefined();
    });
  });

  describe('push', () => {
    test('adds an element to the rear of an empty deque', () => {
      deque.push(1);
      expect(deque.size).toBe(1);
      expect(deque.front()).toBe(1);
      expect(deque.back()).toBe(1);
    });

    test('adds an element to the rear of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.size).toBe(3);
      expect(deque.front()).toBe(1);
      expect(deque.back()).toBe(3);
    });

    test('resizes the deque if it is full', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      deque.push(4);
      expect(deque.size).toBe(4);
      expect(deque.capacity).toBe(6);
      expect(deque.front()).toBe(1);
      expect(deque.back()).toBe(4);
    });
  });

  describe('pop', () => {
    test('returns undefined when deque is empty', () => {
      expect(deque.pop()).toBeUndefined();
    });

    test('removes an element from the rear of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.pop()).toBe(3);
      expect(deque.size).toBe(2);
      expect(deque.front()).toBe(1);
      expect(deque.back()).toBe(2);
    });

    test('removes the last element from the deque', () => {
      deque.push(1);
      expect(deque.pop()).toBe(1);
      expect(deque.size).toBe(0);
      expect(deque.front()).toBeUndefined();
      expect(deque.back()).toBeUndefined();
    });
  });

  describe('resize', () => {
    test('doubles the capacity of the deque when called with no arguments', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.size).toBe(3);
      expect(deque.capacity).toBe(3);
      deque.resize();
      expect(deque.size).toBe(3);
      expect(deque.capacity).toBe(6);
      deque.push(4);
      deque.push(5);
      expect(deque.size).toBe(5);
      expect(deque.capacity).toBe(6);
    });
  
    test('resizes the deque to the specified capacity', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      expect(deque.size).toBe(3);
      expect(deque.capacity).toBe(3);
      deque.resize(5);
      expect(deque.size).toBe(3);
      expect(deque.capacity).toBe(5);
      deque.push(4);
      deque.push(5);
      expect(deque.size).toBe(5);
      expect(deque.capacity).toBe(5);
    });

    it('should resize the deque to no less than size', () => {
      deque.push(1);
      deque.push(2);
      expect(deque.size).toBe(2);
      expect(deque.capacity).toBe(3);
      deque.resize(1);
      expect(deque.size).toBe(2);
      expect(deque.capacity).toBe(2);
    });
  });

  test.each([
    ['self', () => deque, undefined],
    ['self.entries()', () => deque.entries() as Iterable<unknown>, (v: number) => [v - 1, v] as unknown],
    ['self.keys()', () => deque.keys(), (v: number) => (v - 1)],
    ['self.values()', () => deque.values(), undefined],
  ])('should be iterable by %s', (_, iterable, mapper) => {
    const values = [1, 2, 3, 4];
    for (const value of values) {
      deque.push(value);
    }
    for (const value of values) {
      deque.push(value);
    }
    for (const _ of values) {
      deque.pop();
    }

    const expected = values.map(mapper || ((v) => v));
    const actual = Array.from(iterable());
    expect(actual).toEqual(expected);
  });
});

