import { describe, expect, it, test } from '@jest/globals';
import { DualStackDeque } from '../dsdeque.ts';

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

    expect(deque.length).toBe(2);

    deque.clear();
    expect(deque.length).toBe(0);
  });

  test('pop() should remove and return last value', () => {
    const deque = new DualStackDeque<string>();
    const value = 'hello';
    deque.push(value);

    expect(deque.pop()).toBe(value);
    expect(deque.length).toBe(0);
  });

  test('push() should append value to deque', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.length).toBe(0);

    deque.unshift('hello2');
    deque.unshift('hello');
    deque.pop();

    for (const [index, value] of ['world', 'w2'].entries()) {
      deque.push(value);
      expect(deque.length).toBe(2 + index);
      expect(deque.back()).toBe(value);
    }
  });

  test('shift() should remove and return first value', () => {
    const deque = new DualStackDeque<string>();
    const value = 'hello', value2 = 'world';
    deque.push(value2);
    deque.unshift(value);

    expect(deque.shift()).toBe(value);
    expect(deque.length).toBe(1);
    expect(deque.shift()).toBe(value2);
    expect(deque.length).toBe(0);
  });

  test('unshift() should prepend value to deque', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.length).toBe(0);

    deque.push('hello');
    deque.push('hello2');
    deque.shift();

    for (const [index, value] of ['world', 'w2'].entries()) {
      deque.unshift(value);
      expect(deque.length).toBe(2 + index);
      expect(deque.front()).toBe(value);
    }
  });

  test('front, back, shift(), pop() should return undefined for empty container', () => {
    const deque = new DualStackDeque<string>();
    expect(deque.front()).toBeUndefined();
    expect(deque.back()).toBeUndefined();
    expect(deque.shift()).toBeUndefined();
    expect(deque.pop()).toBeUndefined();
  });
});
