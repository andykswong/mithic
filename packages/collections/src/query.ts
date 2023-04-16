import { MaybeAsyncIterableIterator } from '@mithic/commons';

/** A collection that can be queried by range. */
export interface RangeQueryable<K, V> {
  /** Queries event key-value pairs by given criteria. */
  entries(options?: RangeQueryOptions<K>): MaybeAsyncIterableIterator<[K, V]>;

  /** Queries event keys by given criteria. */
  keys(options?: RangeQueryOptions<K>): MaybeAsyncIterableIterator<K>;

  /** Queries events by given criteria. */
  values(options?: RangeQueryOptions<K>): MaybeAsyncIterableIterator<V>;
}

/** Options for querying a {@link RangeQueryable}. */
export interface RangeQueryOptions<K> {
  /** Requires results strictly greater than given key. */
  gt?: K;

  /** Requires results greater than or equal to given key. */
  gte?: K;

  /** Requires results strictly less than given key. */
  lt?: K;

  /** Requires results less than or equal to given key. */
  lte?: K;

  /** Maximum number of results to return. */
  limit?: number;

  /** Iterates results in reverse order. */
  reverse?: boolean;
}
