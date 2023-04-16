import { AbortOptions, MaybePromise } from '@mithic/commons';
import { Queue } from './queue.js';
import { Stack } from './stack.js';

/** A double-ended queue. */
export interface Deque<T> extends Queue<T>, Stack<T> {
  /** Adds an element to the front of this {@link Deque}. */
  unshift(item: T, options?: AbortOptions): MaybePromise<unknown>;
}

/** A {@link Deque} that supports peeking the front/back elements. */
export interface PeekableDeque<T> extends Deque<T> {
  front(options?: AbortOptions): MaybePromise<T | undefined>;

  back(options?: AbortOptions): MaybePromise<T | undefined>;
}

/** A {@link Deque} with synchronous operations. */
export interface SyncDeque<T> extends Deque<T> {
  front?(): T | undefined;

  back?(): T | undefined;

  push(item: T): void;

  pop(): T | undefined;

  unshift(item: T): void;

  shift(): T | undefined;
}
