import { MaybePromise } from '@mithic/commons';
import { MaybeAsyncMap } from './map.ts';
import { MaybeAsyncReadonlySet } from './set.ts';

/** An arena automatically assigns unique key to stored value. */
export interface Arena<K, V> extends MaybeAsyncMap<K, V> {
  /** Adds a value to the arena and returns its key. */
  add(value: V): MaybePromise<K>;

  /** Updates a value on the arena. Does nothing if the key does not exist. */
  set(key: K, value: V): MaybePromise<unknown>;
}

/** A {@link Arena} with synchronous operations. */
export interface SyncArena<K, V> extends Arena<K, V> {
  add(value: V): K;

  set(key: K, value: V): void;

  get(key: K): V | undefined;

  has(key: K): boolean;
}

/** Generator of values. */
export interface ValueGenerator<T> extends MaybeAsyncReadonlySet<T> {
  /** Creates a new value. */
  create(): MaybePromise<T>;

  /** Deletes a value. */
  delete(value: T): MaybePromise<unknown>;
}

/** A {@link ValueGenerator} with synchronous operations. */
export interface SyncGenerator<T> extends ValueGenerator<T> {
  create(): T;

  delete(value: T): void;
}
