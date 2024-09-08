import type { MaybePromise } from '../async/index.ts';

/** A queue, which is a first in, first out data structure. */
export interface Queue<T> {
  /** Returns the length of the queue. */
  readonly length: number;

  /** Returns the first item of this {@link Queue}, or undefined if empty. */
  front?(): MaybePromise<T | undefined>;

  /** Adds an item to this {@link Queue}. */
  push(item: T): MaybePromise<unknown>;

  /** Removes and returns the first item of this {@link Queue}, or undefined if empty. */
  shift(): MaybePromise<T | undefined>;
}

/** A stack data structure. */
export interface Stack<T> {
  /** Returns the top element of this {@link Stack}, or undefined if empty. */
  back?(): MaybePromise<T | undefined>;

  /** Adds an element to this {@link Stack}. */
  push(item: T): MaybePromise<unknown>;

  /** Removes and returns the top element of this {@link Stack}, or undefined if empty. */
  pop(): MaybePromise<T | undefined>;
}

/** A double-ended queue. */
export interface Deque<T> extends Queue<T>, Stack<T> {
  /** Adds an element to the front of this {@link Deque}. */
  unshift(item: T): MaybePromise<unknown>;
}
