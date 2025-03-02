import type { Deque } from './queue.ts';

const DEFAULT_DEQUE_CAPACITY = 16;
const DEFAULT_DEQUE_RESIZE_FACTOR = 2;

/** A double-ended queue using a circular buffer. */
export class ArrayDeque<T> implements Deque<T> {
  private readonly resizeFactor: number;
  private _capacity: number;
  private buffer: T[];
  private frontIdx = -1;
  private backIdx = -1;

  public constructor(
    /** The initial capacity. */
    capacity = DEFAULT_DEQUE_CAPACITY,
    /** The resize factor. When the buffer is full, it will resize to resizeFactor * capacity. */
    resizeFactor = DEFAULT_DEQUE_RESIZE_FACTOR,
  ) {
    this._capacity = capacity;
    this.resizeFactor = resizeFactor;
    this.buffer = Array(capacity);
  }

  public get [Symbol.toStringTag](): string {
    return ArrayDeque.name;
  }

  /** Returns the current capacity of this {@link ArrayDeque}. */
  public get capacity(): number {
    return this._capacity;
  }

  /** Returns the length of this {@link ArrayDeque}. */
  public get length(): number {
    if (this.isEmpty()) {
      return 0;
    }

    if (this.frontIdx <= this.backIdx) {
      return this.backIdx - this.frontIdx + 1;
    } else {
      return this.buffer.length - this.frontIdx + this.backIdx + 1;
    }
  }

  public front(): T | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    return this.buffer[this.frontIdx];
  }

  public back(): T | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    return this.buffer[this.backIdx];
  }

  /** Clears this {@link ArrayDeque}. */
  public clear(): void {
    this.frontIdx = this.backIdx = -1;
  }

  /** Adds an element to the beginning of this {@link ArrayDeque}. */
  public unshift(item: T): void {
    if (this.isFull()) {
      this.resize();
    }

    if (this.isEmpty()) {
      this.frontIdx = this.backIdx = 0;
    } else {
      this.frontIdx = (this.frontIdx - 1 + this.buffer.length) % this.buffer.length;
    }

    this.buffer[this.frontIdx] = item;
  }

  /** Removes and returns the first element of this {@link ArrayDeque}, or undefined if empty. */
  public shift(): T | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    const item = this.buffer[this.frontIdx];
    if (this.frontIdx === this.backIdx) {
      this.frontIdx = this.backIdx = -1;
    } else {
      this.frontIdx = (this.frontIdx + 1) % this.buffer.length;
    }

    return item;
  }

  /** Adds an element to the end of this {@link ArrayDeque}. */
  public push(item: T): void {
    if (this.isFull()) {
      this.resize();
    }

    if (this.isEmpty()) {
      this.frontIdx = this.backIdx = 0;
    } else {
      this.backIdx = (this.backIdx + 1) % this.buffer.length;
    }

    this.buffer[this.backIdx] = item;
  }

  /** Removes and returns the last element of this {@link ArrayDeque}, or undefined if empty. */
  public pop(): T | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    const item = this.buffer[this.backIdx];
    if (this.frontIdx === this.backIdx) {
      this.frontIdx = this.backIdx = -1;
    } else {
      this.backIdx = (this.backIdx - 1 + this.buffer.length) % this.buffer.length;
    }

    return item;
  }

  /**
   * Resizes this {@link ArrayDeque} to the new capacity.
   * By default, it expands to 2x the current capacity.
   * Does nothing if new capacity is less than current size.
   */
  public resize(newCapacity: number = this._capacity * this.resizeFactor): void {
    const size = this.length;
    newCapacity = Math.max(size, newCapacity); // cannot resize to less than size
    const newBuffer = new Array<T>(newCapacity);

    for (let i = 0, j = this.frontIdx; i < size; i++, j = (j + 1) % this._capacity) {
      newBuffer[i] = this.buffer[j];
    }

    this.buffer = newBuffer;
    this.frontIdx = 0;
    this.backIdx = this.length - 1;
    this._capacity = newCapacity;
  }

  private isEmpty(): boolean {
    return this.frontIdx === -1 && this.backIdx === -1;
  }

  private isFull(): boolean {
    return (this.backIdx + 1) % this.buffer.length === this.frontIdx;
  }
}
