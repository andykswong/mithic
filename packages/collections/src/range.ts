import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';

/**
 * Symbol for the instance property that, when set to true,
 * indicates current object is {@link RangeQueryable}.
 */
export const rangeQueryable = Symbol.for('@mithic/rangeQueryable');

/** A collection that can be queried by range. */
export interface RangeQueryable<K, V> extends KeyValueIterable<K, V> {
  /** Queries event key-value pairs by given criteria. */
  entries(options?: RangeQueryOptions<K>): MaybeAsyncIterableIterator<[K, V]>;

  /** Queries event keys by given criteria. */
  keys(options?: RangeQueryOptions<K>): MaybeAsyncIterableIterator<K>;

  /** Queries events by given criteria. */
  values(options?: RangeQueryOptions<K>): MaybeAsyncIterableIterator<V>;

  /** Marker to indicate that this object is a {@link RangeQueryable}. */
  readonly [rangeQueryable]: true;
}

/** A collection that can be iterated by keys and/or values. */
export interface KeyValueIterable<K, V> {
  /** Queries event key-value pairs by given criteria. */
  entries(options?: AbortOptions): MaybeAsyncIterableIterator<[K, V]>;

  /** Queries event keys by given criteria. */
  keys(options?: AbortOptions): MaybeAsyncIterableIterator<K>;

  /** Queries events by given criteria. */
  values(options?: AbortOptions): MaybeAsyncIterableIterator<V>;
}

/** Options for querying a {@link RangeQueryable}. */
export interface RangeQueryOptions<K> extends AbortOptions, RangeAndOrder<K>, LimitOptions { }

/** A value range and order. */
export interface RangeAndOrder<K> extends Range<K>, OrderOptions { }

export interface LimitOptions {
  /** Maximum number of results to return. */
  readonly limit?: number;
}

export interface OrderOptions {
  /** Iterates in reverse order. */
  readonly reverse?: boolean;
}

/** A range of values. */
export interface Range<T> {
  /** Lower bound of the range. */
  readonly lower?: T;

  /** Whether the lower bound is open. Defaults to false. */
  readonly lowerOpen?: boolean;

  /** Upper bound of the range. */
  readonly upper?: T;

  /** Whether the upper bound is open. Defaults to true. */
  readonly upperOpen?: boolean;
}
