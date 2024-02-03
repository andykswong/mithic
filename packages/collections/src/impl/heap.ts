import { PeekableQueue, SyncQueue } from '../queue.ts';

/** A binary heap. */
export class BinaryHeap<T> implements PeekableQueue<T>, SyncQueue<T> {
  private heap: T[];

  public constructor(
    /** Initial elements for this heap. */
    items?: Iterable<T>,
    /** The compare function to order elements. */
    private readonly compare: (lhs: T, rhs: T) => number = defaultCompare,
    /** Whether to heapify the initial elements. Set this to false if elements are already in heap order. */
    heapify = true
  ) {
    this.heap = items ? Array.from(items) : [];
    if (items && heapify) {
      for (let i = this.parent(this.heap.length - 1); i >= 0; i--) {
        this.heapifyDown(i);
      }
    }
  }

  /** Returns the size of this {@link BinaryHeap}. */
  public get size(): number {
    return this.heap.length;
  }

  /** Returns the top element, or undefined if empty. */
  public front(): T | undefined {
    return this.heap[0];
  }

  /** Clears this {@link BinaryHeap}. */
  public clear(): void {
    this.heap.length = 0;
  }

  /** Adds an element to this heap. */
  public push(value: T): void {
    this.heap.push(value);
    this.heapifyUp(this.size - 1);
  }

  /** Removes and returns the top element, or undefined if empty. */
  public shift(): T | undefined {
    const top = this.heap[0];
    this.heap[0] = this.heap[this.size - 1];
    this.heap.pop();
    if (this.size > 0) {
      this.heapifyDown(0);
    }
    return top;
  }

  private parent(index: number): number {
    return Math.floor((index - 1) / 2);
  }

  private heapifyUp(index: number): void {
    const value = this.heap[index];
    while (index > 0) {
      const parentIndex = this.parent(index);
      const parent = this.heap[parentIndex];
      if (this.compare(value, parent) < 0) {
        this.heap[index] = parent;
        index = parentIndex;
      } else {
        break;
      }
    }
    this.heap[index] = value;
  }

  private heapifyDown(index: number): void {
    const value = this.heap[index];
    while (index < this.size) {
      const leftIndex = 2 * index + 1;
      const rightIndex = 2 * index + 2;
      let smallerChildIndex = index;
      if (leftIndex < this.size && this.compare(this.heap[leftIndex],this.heap[smallerChildIndex]) < 0) {
        smallerChildIndex = leftIndex;
      }
      if (rightIndex < this.size && this.compare(this.heap[rightIndex], this.heap[smallerChildIndex]) < 0) {
        smallerChildIndex = rightIndex;
      }
      if (smallerChildIndex === index) {
        break;
      }
      this.heap[index] = this.heap[smallerChildIndex];
      index = smallerChildIndex;
    }
    this.heap[index] = value;
  }
}

/** Default compare function. */
function defaultCompare<T>(lhs: T, rhs: T): number {
  if (Object.is(lhs, rhs) || lhs == rhs) {
    return 0;
  }
  return lhs > rhs ? 1 : -1;
}
