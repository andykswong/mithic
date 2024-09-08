import { type Deque } from './queue.ts';

/** A dual stack based double-ended queue. */
export class DualStackDeque<T> implements Deque<T> {
  private readonly minLoadFactor: number;
  private readonly frontStack: (T | undefined)[] = [];
  private readonly backStack: (T | undefined)[] = [];
  private frontOffset = 0;
  private backOffset = 0;

  public constructor(minLoadFactor = 0.5) {
    this.minLoadFactor = Math.max(0, Math.min(minLoadFactor, 1));
  }

  public get length(): number {
    return (this.frontStack.length - this.frontOffset) + (this.backStack.length - this.backOffset);
  }

  public front(): T | undefined {
    if (this.length === 0) {
      return;
    }

    if (this.frontStack.length) {
      return this.frontStack[this.frontStack.length - 1];
    }

    return this.backStack[this.backOffset];
  }

  public back(): T | undefined {
    if (this.length === 0) {
      return;
    }

    if (this.backStack.length) {
      return this.backStack[this.backStack.length - 1];
    }
    return this.frontStack[this.frontOffset];
  }

  /** Clears this deque. */
  public clear(): void {
    this.backStack.length = this.frontStack.length = 0;
    this.backOffset = this.frontOffset = 0;
  }

  public unshift(value: T): void {
    if (this.backOffset) {
      this.backStack[--this.backOffset] = value;
    } else {
      this.frontStack.push(value);
    }
  }

  public shift(): T | undefined {
    if (this.frontStack.length - this.frontOffset) {
      return this.frontStack.pop();
    }

    if (this.backStack.length - this.backOffset) {
      const [first, backOffset] = dequeueAndResize(this.backStack, this.backOffset, this.minLoadFactor);
      this.backOffset = backOffset;
      return first;
    }

    return undefined;
  }

  public push(value: T): void {
    if (this.frontOffset) {
      this.frontStack[--this.frontOffset] = value;
    } else {
      this.backStack.push(value);
    }
  }

  public pop(): T | undefined {
    if (this.backStack.length - this.backOffset) {
      return this.backStack.pop();
    }

    if (this.frontStack.length - this.frontOffset) {
      const [last, frontOffset] = dequeueAndResize(this.frontStack, this.frontOffset, this.minLoadFactor);
      this.frontOffset = frontOffset;
      return last;
    }

    return undefined;
  }

  public get [Symbol.toStringTag](): string {
    return DualStackDeque.name;
  }
}

function dequeueAndResize<T>(
  stack: (T | undefined)[], offset: number, minLoadFactor: number
): [front: T | undefined, newOffset: number] {
  const first = stack[offset++];

  const loadFactor = 1 - offset / stack.length;
  if (loadFactor < minLoadFactor) {
    stack.copyWithin(0, offset);
    stack.length -= offset;
    offset = 0;
  } else {
    stack[offset - 1] = undefined;
  }

  return [first, offset];
}
