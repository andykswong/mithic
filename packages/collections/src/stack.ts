import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A stack data structure. */
export interface Stack<T> {
  /** Returns the top element of this {@link Stack}, or undefined if empty. */
  back?(options?: AbortOptions): MaybePromise<T | undefined>;

  /** Adds an element to this {@link Stack}. */
  push(item: T, options?: AbortOptions): MaybePromise<unknown>;

  /** Removes and returns the top element of this {@link Stack}, or undefined if empty. */
  pop(options?: AbortOptions): MaybePromise<T | undefined>;
}

/** A {@link Stack} that supports peeking the back (top) element. */
export interface PeekableStack<T> extends Stack<T> {
  back(options?: AbortOptions): MaybePromise<T | undefined>;
}

/** A {@link Stack} with synchronous operations. */
export interface SyncStack<T> extends Stack<T> {
  back?(): T | undefined;

  push(item: T): void;

  pop(): T | undefined;
}
