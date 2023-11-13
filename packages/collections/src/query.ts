import { AbortOptions, Codec, MaybeAsyncIterableIterator } from '@mithic/commons';

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
export interface RangeQueryOptions<K> extends AbortOptions, KeyRange<K> {
  /** Maximum number of results to return. */
  readonly limit?: number;
}

/** A key range. */
export interface KeyRange<K> {
  /** Requires keys strictly greater than given key. */
  readonly gt?: K;

  /** Requires keys greater than or equal to given key. */
  readonly gte?: K;

  /** Requires keys strictly less than given key. */
  readonly lt?: K;

  /** Requires keys less than or equal to given key. */
  readonly lte?: K;

  /** Iterates in reverse order. */
  readonly reverse?: boolean;
}

/** Codec for a range key. */
export interface RangeKeyCodec<V, T> extends Codec<V, T> {
  /** Optional method to encode a key range. */
  encodeRange?: (range: KeyRange<V>) => KeyRange<T>;
}
