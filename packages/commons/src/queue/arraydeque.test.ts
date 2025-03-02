import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ArrayDeque } from './index.ts';

describe('ArrayDeque', () => {
  let deque: ArrayDeque<number>;

  beforeEach(() => {
    deque = new ArrayDeque<number>(3);
  });

  it('should have correct string tag', () => {
    assert.strictEqual(`${deque}`, `[object ${ArrayDeque.name}]`);
  });

  describe('size', () => {
    it('should return the size of the deque', () => {
      assert.strictEqual(deque.length, 0);
      deque.unshift(1);
      deque.push(2);
      assert.strictEqual(deque.length, 2);
      deque.shift();
      assert.strictEqual(deque.length, 1);
      deque.pop();
      assert.strictEqual(deque.length, 0);
    });
  });

  describe('capacity', () => {
    it('should return the capacity of the deque', () => {
      assert.strictEqual(deque.capacity, 3);
      deque.unshift(1);
      deque.push(2);
      deque.push(3);
      deque.push(4);
      assert.strictEqual(deque.capacity, 6);
    });
  });

  describe('front', () => {
    it('should return undefined when deque is empty', () => {
      assert.strictEqual(deque.front(), undefined);
    });

    it('should return the front element without removing it', () => {
      deque.push(1);
      deque.push(2);
      assert.strictEqual(deque.front(), 1);
      assert.strictEqual(deque.length, 2);
    });
  });

  describe('back', () => {
    it('should return undefined when deque is empty', () => {
      assert.strictEqual(deque.back(), undefined);
    });

    it('should return the rear element without removing it', () => {
      deque.push(1);
      deque.push(2);
      assert.strictEqual(deque.back(), 2);
      assert.strictEqual(deque.length, 2);
    });
  });

  describe('clear', () => {
    it('should clear all elements from the deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      assert.strictEqual(deque.length, 3);
      deque.clear();
      assert.strictEqual(deque.length, 0);
      assert.strictEqual(deque.front(), undefined);
      assert.strictEqual(deque.back(), undefined);
    });
  });

  describe('unshift', () => {
    it('should add an element to the front of an empty deque', () => {
      deque.unshift(1);
      assert.strictEqual(deque.length, 1);
      assert.strictEqual(deque.front(), 1);
      assert.strictEqual(deque.back(), 1);
    });

    it('should add an element to the front of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.unshift(3);
      assert.strictEqual(deque.length, 3);
      assert.strictEqual(deque.front(), 3);
      assert.strictEqual(deque.back(), 2);
    });

    it('should resize the deque if it is full', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      deque.unshift(4);
      assert.strictEqual(deque.length, 4);
      assert.strictEqual(deque.capacity, 6);
      assert.strictEqual(deque.front(), 4);
      assert.strictEqual(deque.back(), 3);
    });
  });

  describe('shift', () => {
    it('should return undefined when deque is empty', () => {
      assert.strictEqual(deque.shift(), undefined);
    });

    it('should remove an element from the front of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      assert.strictEqual(deque.shift(), 1);
      assert.strictEqual(deque.length, 2);
      assert.strictEqual(deque.front(), 2);
      assert.strictEqual(deque.back(), 3);
    });

    it('should remove the last element from the deque', () => {
      deque.push(1);
      assert.strictEqual(deque.shift(), 1);
      assert.strictEqual(deque.length, 0);
      assert.strictEqual(deque.front(), undefined);
      assert.strictEqual(deque.back(), undefined);
    });
  });

  describe('push', () => {
    it('should add an element to the rear of an empty deque', () => {
      deque.push(1);
      assert.strictEqual(deque.length, 1);
      assert.strictEqual(deque.front(), 1);
      assert.strictEqual(deque.back(), 1);
    });

    it('should add an element to the rear of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      assert.strictEqual(deque.length, 3);
      assert.strictEqual(deque.front(), 1);
      assert.strictEqual(deque.back(), 3);
    });

    it('should resize the deque if it is full', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      deque.push(4);
      assert.strictEqual(deque.length, 4);
      assert.strictEqual(deque.capacity, 6);
      assert.strictEqual(deque.front(), 1);
      assert.strictEqual(deque.back(), 4);
    });
  });

  describe('pop', () => {
    it('should return undefined when deque is empty', () => {
      assert.strictEqual(deque.pop(), undefined);
    });

    it('should remove an element from the rear of a non-empty deque', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      assert.strictEqual(deque.pop(), 3);
      assert.strictEqual(deque.length, 2);
      assert.strictEqual(deque.front(), 1);
      assert.strictEqual(deque.back(), 2);
    });

    it('should remove the last element from the deque', () => {
      deque.push(1);
      assert.strictEqual(deque.pop(), 1);
      assert.strictEqual(deque.length, 0);
      assert.strictEqual(deque.front(), undefined);
      assert.strictEqual(deque.back(), undefined);
    });
  });

  describe('resize', () => {
    it('should double the capacity of the deque when called with no arguments', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      assert.strictEqual(deque.length, 3);
      assert.strictEqual(deque.capacity, 3);
      deque.resize();
      assert.strictEqual(deque.length, 3);
      assert.strictEqual(deque.capacity, 6);
      deque.push(4);
      deque.push(5);
      assert.strictEqual(deque.length, 5);
      assert.strictEqual(deque.capacity, 6);
    });

    it('should resize the deque to the specified capacity', () => {
      deque.push(1);
      deque.push(2);
      deque.push(3);
      assert.strictEqual(deque.length, 3);
      assert.strictEqual(deque.capacity, 3);
      deque.resize(5);
      assert.strictEqual(deque.length, 3);
      assert.strictEqual(deque.capacity, 5);
      deque.push(4);
      deque.push(5);
      assert.strictEqual(deque.length, 5);
      assert.strictEqual(deque.capacity, 5);
    });

    it('should resize the deque to no less than size', () => {
      deque.push(1);
      deque.push(2);
      assert.strictEqual(deque.length, 2);
      assert.strictEqual(deque.capacity, 3);
      deque.resize(1);
      assert.strictEqual(deque.length, 2);
      assert.strictEqual(deque.capacity, 2);
    });
  });
});
