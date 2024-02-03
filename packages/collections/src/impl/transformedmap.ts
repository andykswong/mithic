import { AbortOptions, Codec, IdentityCodec, MaybePromise } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.ts';
import { deleteMany, getMany, hasMany, setMany, updateMapMany } from '../utils/batch.ts';
import { KeyValueIterable, RangeQueryOptions, RangeQueryable, rangeQueryable } from '../range.ts';

/**
 * A map adapter that serializes keys and/or values with codec.
 * Key codec needs to be monotonic to preserve iteration order.
 */
export class TransformedMap<
  K, V, TK = K, TV = V,
  M extends MaybeAsyncMap<TK, TV> &
  Partial<MaybeAsyncMapBatch<TK, TV> & Iterable<[TK, TV]> & AsyncIterable<[TK, TV]> & RangeQueryable<TK, TV>>
  = MaybeAsyncMap<TK, TV> &
  Partial<MaybeAsyncMapBatch<TK, TV> & Iterable<[TK, TV]> & AsyncIterable<[TK, TV]> & RangeQueryable<TK, TV>>
> implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>,
  Partial<Iterable<[K, V]> & AsyncIterable<[K, V]> & RangeQueryable<K, V>>
{
  public [Symbol.iterator]!: M extends Iterable<[TK, TV]> ? () => IterableIterator<[K, V]> : undefined;
  public [Symbol.asyncIterator]!:
    M extends (Iterable<[TK, TV]> | AsyncIterable<[TK, TV]>) ? () => AsyncIterableIterator<[K, V]> : undefined;

  public readonly [rangeQueryable]: M extends RangeQueryable<TK, TV> ? true : undefined;
  public entries: TransformedMapQuery<K, TK, TV, M, [K, V]>;
  public keys: TransformedMapQuery<K, TK, TV, M, K>;
  public values: TransformedMapQuery<K, TK, TV, M, V>;

  public constructor(
    /** Underlying map. */
    public readonly map: M,
    /** Key codec. */
    protected readonly keyCodec: Codec<K, TK> = IdentityCodec as Codec<K, TK>,
    /** Value codec. */
    protected readonly valueCodec: Codec<V, TV> = IdentityCodec as Codec<V, TV>,
  ) {
    type This = TransformedMap<K, V, TK, TV, M>;

    this[Symbol.iterator] = (Symbol.iterator in map ? function* () {
      for (const [key, value] of map as Iterable<[TK, TV]>) {
        yield [keyCodec.decode(key), valueCodec.decode(value)];
      }
    } : void 0) as This[typeof Symbol.iterator];

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) ? async function* () {
      for await (const [key, value] of map as AsyncIterable<[TK, TV]>) {
        yield [keyCodec.decode(key), valueCodec.decode(value)];
      }
    } : void 0) as This[typeof Symbol.asyncIterator];

    this[rangeQueryable] = map[rangeQueryable] as This[typeof rangeQueryable];

    const encodeRangeQuery = (options?: RangeQueryOptions<K>): RangeQueryOptions<TK> => {
      return {
        ...options,
        lower: options?.lower === void 0 ? void 0 : keyCodec.encode(options.lower),
        upper: options?.upper === void 0 ? void 0 : keyCodec.encode(options.upper),
      };
    };

    this.keys = ('keys' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (const key of (map as RangeQueryable<TK, TV>).keys(encodeRangeQuery(options))) {
        yield keyCodec.decode(key);
      }
    } : void 0) as This['keys'];

    this.values = ('values' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (const value of (map as RangeQueryable<TK, TV>).values(encodeRangeQuery(options))) {
        yield valueCodec.decode(value);
      }
    } : void 0) as This['values'];

    this.entries = ('entries' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (
        const [key, value] of (map as RangeQueryable<TK, TV>).entries(encodeRangeQuery(options))
      ) {
        yield [keyCodec.decode(key), valueCodec.decode(value)];
      }
    } : void 0) as This['entries'];
  }

  public get(key: K, options?: AbortOptions): MaybePromise<V | undefined> {
    return MaybePromise.map(this.map.get(this.keyCodec.encode(key), options), this.decodeOptionalValue);
  }

  public set(key: K, value: V, options?: AbortOptions): MaybePromise<unknown> {
    return this.map.set(this.keyCodec.encode(key), this.valueCodec.encode(value), options);
  }

  public delete(key: K, options?: AbortOptions): MaybePromise<unknown> {
    return this.map.delete(this.keyCodec.encode(key), options);
  }

  public has(key: K, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(this.keyCodec.encode(key), options);
  }

  public async * getMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    for await (const value of getMany(this.map, [...keys].map(this.encodeKey), options)) {
      options?.signal?.throwIfAborted();
      yield this.decodeOptionalValue(value);
    }
  }

  public hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return hasMany(this.map, [...keys].map(this.encodeKey), options);
  }

  public setMany(entries: Iterable<[K, V]>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return setMany(
      this.map, [...entries].map(([key, value]) => [this.keyCodec.encode(key), this.valueCodec.encode(value)]), options
    );
  }

  public deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return deleteMany(this.map, [...keys].map(this.encodeKey), options);
  }

  public updateMany(
    entries: Iterable<[K, V?]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    return updateMapMany(
      this.map,
      [...entries].map(
        ([key, value]) => [this.keyCodec.encode(key), value === void 0 ? void 0 : this.valueCodec.encode(value)]
      ),
      options
    );
  }

  public get [Symbol.toStringTag](): string {
    return TransformedMap.name;
  }

  protected encodeKey = (key: K): TK => this.keyCodec.encode(key);

  protected decodeOptionalValue = (value?: TV): V | undefined => {
    return value === void 0 ? void 0 : this.valueCodec.decode(value);
  };
}

/** Query function type for a {@link TransformedMap}. */
export type TransformedMapQuery<K, TK, TV, M, E> =
  M extends RangeQueryable<TK, TV> ? (options?: RangeQueryOptions<K>) => AsyncIterableIterator<E> :
  M extends KeyValueIterable<TK, TV> ? (options?: AbortOptions) => AsyncIterableIterator<E> : undefined;
