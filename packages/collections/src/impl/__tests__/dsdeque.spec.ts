import { describe, expect, it, test } from '@jest/globals';
import { DualStackDeque } from '../dsdeque.js';

describe(DualStackDeque.name, () => {
  it('should have correct string tag', () => {
    expect(`${new DualStackDeque<string>()}`).toBe(`[object ${DualStackDeque.name}]`);
  });

  test('front should return first element', () => {
    const deque = new DualStackDeque<string>();
    const value = '1';
    deque.push(value);
    expect(deque.front()).toBe(value);
  });

  test('back should return last element', () => {
    const deque = new DualStackDeque<string>();
    const value = '1';
    deque.unshift(value);
    expect(deque.back()).toBe(value);
  });

  test('clear() should empty the container', () => {
    const deque = new DualStackDeque<string>();
    deque.push('1');
    deque.push('2');

    expect(deque.size).toBe(2);

    deque.clear();
    expect(deque.size).toBe(0);
  });

  test('pop() should remove and return last value', () => {
    const deque = new DualStackDeque<string>();
    const value = 'hello';
    deque.push(value);

    expect(deque.pop()).toBe(value);
    expect(deque.size).toBe(0);
  });

  test('push() should append value to deque', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.size).toBe(0);

    deque.unshift('hello2');
    deque.unshift('hello');
    deque.pop();

    for (const [index, value] of ['world', 'w2'].entries()) {
      deque.push(value);
      expect(deque.size).toBe(2 + index);
      expect(deque.back()).toBe(value);
      expect(deque.get(deque.size - 1)).toBe(value);
      expect(deque.has(deque.size - 1)).toBeTruthy();
    }
  });

  test('shift() should remove and return first value', () => {
    const deque = new DualStackDeque<string>();
    const value = 'hello', value2 = 'world';
    deque.push(value2);
    deque.unshift(value);

    expect(deque.shift()).toBe(value);
    expect(deque.size).toBe(1);
    expect(deque.shift()).toBe(value2);
    expect(deque.size).toBe(0);
  });

  test('unshift() should prepend value to deque', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.size).toBe(0);

    deque.push('hello');
    deque.push('hello2');
    deque.shift();

    for (const [index, value] of ['world', 'w2'].entries()) {
      deque.unshift(value);
      expect(deque.size).toBe(2 + index);
      expect(deque.front()).toBe(value);
      expect(deque.get(0)).toBe(value);
    }
  });

  test('front, back, shift(), pop() should return undefined for empty container', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.front()).toBeUndefined();
    expect(deque.back()).toBeUndefined();
    expect(deque.shift()).toBeUndefined();
    expect(deque.pop()).toBeUndefined();
  });

  test('set() should update value of existing key', () => {
    const deque = new DualStackDeque<string>();
    deque.unshift('hello');
    deque.push('world');

    const newValue = 'new';
    deque.set(0, newValue);
    expect(deque.get(0)).toBe(newValue);

    deque.set(1, newValue);
    expect(deque.get(1)).toBe(newValue);
  });

  test('get() should return undefined for non-existent key', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.get(123)).toBeUndefined();
  });

  test('has() should false for non-existent key', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.has(123)).toBeFalsy();
  });

  describe('iterators', () => {
    test('entries() should iterate through all id-values', () => {
      const deque = new DualStackDeque<string>();
      const value1 = 'hello', value2 = 'world';
      deque.unshift(value1);
      deque.push(value2);

      const results: [number, string][] = [];
      for (const entry of deque.entries()) {
        results.push(entry);
      }

      expect(results).toEqual([[0, value1], [1, value2]]);
    });

    test('keys() should iterate through all ids', () => {
      const deque = new DualStackDeque<string>();
      const value1 = 'hello', value2 = 'world';
      deque.unshift(value1);
      deque.push(value2);

      const results: number[] = [];
      for (const key of deque.keys()) {
        results.push(key);
      }

      expect(results).toEqual([0, 1]);
    });

    test('values() should iterate through all values', () => {
      const deque = new DualStackDeque<string>();
      const value1 = 'hello', value2 = 'world';
      deque.unshift(value1);
      deque.push(value2);

      const results: string[] = [];
      for (const value of deque.values()) {
        results.push(value);
      }

      expect(results).toEqual([value1, value2]);
    });

    test('[Symbol.iterator]() should iterate through all id-values', () => {
      const deque = new DualStackDeque<string>();
      const value1 = 'hello', value2 = 'world';
      deque.unshift(value1);
      deque.push(value2);

      const results: string[] = [];
      for (const entry of deque) {
        results.push(entry);
      }

      expect(results).toEqual([value1, value2]);
    });
  });
});
