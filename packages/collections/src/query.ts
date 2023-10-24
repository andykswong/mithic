import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';

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
export interface RangeQueryOptions<K> extends AbortOptions {
  /** Requires results strictly greater than given key. */
  readonly gt?: K;

  /** Requires results greater than or equal to given key. */
  readonly gte?: K;

  /** Requires results strictly less than given key. */
  readonly lt?: K;

  /** Requires results less than or equal to given key. */
  readonly lte?: K;

  /** Maximum number of results to return. */
  readonly limit?: number;

  /** Iterates results in reverse order. */
  readonly reverse?: boolean;
}
