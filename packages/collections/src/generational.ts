import { MaybePromise } from '@mithic/commons';
import { MaybeAsyncReadonlyMap } from './map.js';

/** An arena automatically assigns unique key to stored value. */
export interface Arena<K, V> extends MaybeAsyncReadonlyMap<K, V> {
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
export interface ValueGenerator<T> extends ReadonlySet<T> {
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
