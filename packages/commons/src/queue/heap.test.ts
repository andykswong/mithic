import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BinaryHeap } from './index.ts';

describe('BinaryHeap', () => {
  describe('constructor', () => {
    it('should create an empty heap by default', () => {
      const heap = new BinaryHeap<number>();
      assert.strictEqual(heap.length, 0);
      assert.strictEqual(heap.front(), undefined);
    });

    it('should create a heap from an array of elements', () => {
      const elements = [5, 2, 4, 3, 1];
      const heap = new BinaryHeap(elements);
      assert.strictEqual(heap.length, elements.length);
      assert.strictEqual(heap.front(), Math.min(...elements));
    });

    it('should create a heap from an iterable of elements', () => {
      const elements = new Set([5, 2, 5, 4, 3, 1]);
      const heap = new BinaryHeap(elements.values());
      assert.strictEqual(heap.length, elements.size);
      assert.strictEqual(heap.front(), Math.min(...elements));
    });

    it('should create a heap with a custom compare function', () => {
      const elements = ['foo', 'bar', 'baz0', 'qux12'];
      const compare = (lhs: string, rhs: string) => lhs.length - rhs.length;
      const heap = new BinaryHeap(elements, compare);
      assert.strictEqual(heap.length, elements.length);
      assert.strictEqual(heap.front(), 'foo');
    });

    it('should create a heap without heapifying the elements', () => {
      const elements = [5, 2, 4, 3, 1];
      const heap = new BinaryHeap(elements, undefined, false);
      assert.strictEqual(heap.length, elements.length);
      assert.strictEqual(heap.front(), 5);
      heap.push(0);
      assert.strictEqual(heap.front(), 0);
    });
  });

  describe('clear', () => {
    it('should remove all elements from a non-empty heap', () => {
      const heap = new BinaryHeap([5, 2, 4, 3, 1]);
      heap.clear();
      assert.strictEqual(heap.length, 0);
      assert.strictEqual(heap.front(), undefined);
    });
  });

  describe('push', () => {
    it('should add an element to an empty heap', () => {
      const heap = new BinaryHeap<number>();
      heap.push(42);
      assert.strictEqual(heap.length, 1);
      assert.strictEqual(heap.front(), 42);
    });

    it('should maintain the heap property', () => {
      const heap = new BinaryHeap([3, 1, 4]);
      heap.push(0);
      assert.strictEqual(heap.length, 4);
      assert.strictEqual(heap.front(), 0);
      heap.push(2);
      assert.strictEqual(heap.length, 5);
      assert.strictEqual(heap.front(), 0);
    });
  });

  describe('shift', () => {
    it('should remove and return the top element of a non-empty heap', () => {
      const heap = new BinaryHeap([5, 2, 4, 3, 1]);
      const top = heap.shift();
      assert.strictEqual(top, 1);
      assert.strictEqual(heap.length, 4);
      assert.strictEqual(heap.front(), 2);
    });

    it('should maintain the heap property', () => {
      const heap = new BinaryHeap([5, 2, 4, 3, 1]);
      for (let i = 1; i <= 5; ++i) {
        const top = heap.shift();
        assert.strictEqual(top, i);
        assert.strictEqual(heap.length, 5 - i);
        if (i === 5) {
          assert.strictEqual(heap.front(), undefined);
        } else {
          assert.strictEqual(heap.front(), i + 1);
        }
      }
    });

    it('should return undefined for an empty heap', () => {
      const heap = new BinaryHeap<number>();
      const top = heap.shift();
      assert.strictEqual(top, undefined);
      assert.strictEqual(heap.length, 0);
      assert.strictEqual(heap.front(), undefined);
    });
  });
});
