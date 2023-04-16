import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A queue data structure. */
export interface Queue<T> {
  /** Returns the first item of this {@link Queue}, or undefined if empty. */
  front?(options?: AbortOptions): MaybePromise<T | undefined>;

  /** Adds an item to this {@link Queue}. */
  push(item: T, options?: AbortOptions): MaybePromise<unknown>;

  /** Removes and returns the first item of this {@link Queue}, or undefined if empty. */
  shift(options?: AbortOptions): MaybePromise<T | undefined>;
}

/** A {@link Queue} that supports peeking the front element. */
export interface PeekableQueue<T> extends Queue<T> {
  front(options?: AbortOptions): MaybePromise<T | undefined>;
}

/** A {@link Queue} with synchronous operations. */
export interface SyncQueue<T> extends Queue<T> {
  front?(): T | undefined;

  push(item: T): void;

  shift(): T | undefined;
}
