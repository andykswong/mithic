import { BinaryHeap } from '../heap.js';

describe(BinaryHeap.name, () => {
  describe('constructor', () => {
    it('should create an empty heap by default', () => {
      const heap = new BinaryHeap<number>();
      expect(heap.size).toBe(0);
      expect(heap.front()).toBeUndefined();
    });

    it('should create a heap from an array of elements', () => {
      const elements = [5, 2, 4, 3, 1];
      const heap = new BinaryHeap(elements);
      expect(heap.size).toBe(elements.length);
      expect(heap.front()).toBe(Math.min(...elements));
    });

    it('should create a heap from an iterable of elements', () => {
      const elements = new Set([5, 2, 5, 4, 3, 1]);
      const heap = new BinaryHeap(elements.values());
      expect(heap.size).toBe(elements.size);
      expect(heap.front()).toBe(Math.min(...elements));
    });

    it('should create a heap with a custom compare function', () => {
      const elements = ['foo', 'bar', 'baz0', 'qux12'];
      const compare = (lhs: string, rhs: string) => lhs.length - rhs.length;
      const heap = new BinaryHeap(elements, compare);
      expect(heap.size).toBe(elements.length);
      expect(heap.front()).toBe('foo');
    });

    it('should create a heap without heapifying the elements', () => {
      const elements = [5, 2, 4, 3, 1];
      const heap = new BinaryHeap(elements, undefined, false);
      expect(heap.size).toBe(elements.length);
      expect(heap.front()).toBe(5);
      heap.push(0);
      expect(heap.front()).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all elements from a non-empty heap', () => {
      const heap = new BinaryHeap([5, 2, 4, 3, 1]);
      heap.clear();
      expect(heap.size).toBe(0);
      expect(heap.front()).toBeUndefined();
    });
  });

  describe('push', () => {
    it('should add an element to an empty heap', () => {
      const heap = new BinaryHeap<number>();
      heap.push(42);
      expect(heap.size).toBe(1);
      expect(heap.front()).toBe(42);
    });

    it('should maintain the heap property', () => {
      const heap = new BinaryHeap([3, 1, 4]);
      heap.push(0);
      expect(heap.size).toBe(4);
      expect(heap.front()).toBe(0);
      heap.push(2);
      expect(heap.size).toBe(5);
      expect(heap.front()).toBe(0);
    });
  });

  describe('shift', () => {
    it('should remove and return the top element of a non-empty heap', () => {
      const heap = new BinaryHeap([5, 2, 4, 3, 1]);
      const top = heap.shift();
      expect(top).toBe(1);
      expect(heap.size).toBe(4);
      expect(heap.front()).toBe(2);
    });

    it('should maintain the heap property', () => {
      const heap = new BinaryHeap([5, 2, 4, 3, 1]);
      for (let i = 1; i <= 5; ++i) {
        const top = heap.shift();
        expect(top).toBe(i);
        expect(heap.size).toBe(5 - i);
        if (i === 5) {
          expect(heap.front()).toBeUndefined();
        } else {
          expect(heap.front()).toBe(i + 1);
        }
      }
    });

    it('should return undefined for an empty heap', () => {
      const heap = new BinaryHeap<number>();
      const top = heap.shift();
      expect(top).toBeUndefined();
      expect(heap.size).toBe(0);
      expect(heap.front()).toBeUndefined();
    });
  });
});
