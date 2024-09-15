import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DualStackDeque } from './index.ts';

describe('DualStackDeque', () => {
  it('should have correct string tag', () => {
    assert.strictEqual(`${new DualStackDeque<string>()}`, `[object ${DualStackDeque.name}]`);
  });

  it('should return undefined for front(), back(), shift(), pop() when empty', () => {
    const deque = new DualStackDeque<string>();
    assert.strictEqual(deque.front(), undefined);
    assert.strictEqual(deque.back(), undefined);
    assert.strictEqual(deque.shift(), undefined);
    assert.strictEqual(deque.pop(), undefined);
  });

  describe('front', () => {
    it('should return first element', () => {
      const deque = new DualStackDeque<string>();
      const value = '1';
      deque.push(value);
      assert.strictEqual(deque.front(), value);
    });
  });

  describe('back', () => {
    it('should return last element', () => {
      const deque = new DualStackDeque<string>();
      const value = '1';
      deque.unshift(value);
      assert.strictEqual(deque.back(), value);
    });
  });

  describe('clear', () => {
    it('should empty the container', () => {
      const deque = new DualStackDeque<string>();
      deque.push('1');
      deque.push('2');

      assert.strictEqual(deque.length, 2);

      deque.clear();
      assert.strictEqual(deque.length, 0);
    });
  });

  describe('pop', () => {
    it('should remove and return last value', () => {
      const deque = new DualStackDeque<string>();
      const value = 'hello';
      deque.push(value);

      assert.strictEqual(deque.pop(), value);
      assert.strictEqual(deque.length, 0);
    });
  });

  describe('push', () => {
    it('should append value to deque', () => {
      const deque = new DualStackDeque<string>();
      assert.strictEqual(deque.length, 0);

      deque.unshift('hello2');
      deque.unshift('hello');
      deque.pop();

      for (const [index, value] of ['world', 'w2'].entries()) {
        deque.push(value);
        assert.strictEqual(deque.length, 2 + index);
        assert.strictEqual(deque.back(), value);
      }
    });
  });

  describe('shift', () => {
    it('should remove and return first value', () => {
      const deque = new DualStackDeque<string>();
      const value = 'hello', value2 = 'world';
      deque.push(value2);
      deque.unshift(value);

      assert.strictEqual(deque.shift(), value);
      assert.strictEqual(deque.length, 1);
      assert.strictEqual(deque.shift(), value2);
      assert.strictEqual(deque.length, 0);
    });
  });

  describe('unshift', () => {
    it('should prepend value to deque', () => {
      const deque = new DualStackDeque<string>();
      assert.strictEqual(deque.length, 0);

      deque.push('hello');
      deque.push('hello2');
      deque.shift();

      for (const [index, value] of ['world', 'w2'].entries()) {
        deque.unshift(value);
        assert.strictEqual(deque.length, 2 + index);
        assert.strictEqual(deque.front(), value);
      }
    });
  });
});
