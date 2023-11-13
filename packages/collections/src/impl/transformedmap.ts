import { AbortOptions, Codec, IdentityCodec, MaybePromise } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { deleteMany, getMany, hasMany, setMany, updateMapMany } from '../utils/batch.js';
import { KeyRange, RangeKeyCodec, RangeQueryOptions, RangeQueryable } from '../query.js';

/** A map adapter that transforms keys and/or values. */
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
  public entries: M extends RangeQueryable<TK, TV> ?
    (options?: RangeQueryOptions<K>) => AsyncIterableIterator<[K, V]> : undefined;
  public keys: M extends RangeQueryable<TK, TV> ?
    (options?: RangeQueryOptions<K>) => AsyncIterableIterator<K> : undefined;
  public values: M extends RangeQueryable<TK, TV> ?
    (options?: RangeQueryOptions<K>) => AsyncIterableIterator<V> : undefined;

  public constructor(
    /** Underlying map. */
    public readonly map: M,
    /** Key codec. */
    protected readonly keyCodec: RangeKeyCodec<K, TK> = IdentityCodec as RangeKeyCodec<K, TK>,
    /** Value codec. */
    protected readonly valueCodec: Codec<V, TV> = IdentityCodec as Codec<V, TV>,
  ) {
    this[Symbol.iterator] = (Symbol.iterator in map ? function* () {
      for (const [key, value] of map as Iterable<[TK, TV]>) {
        yield [keyCodec.decode(key), valueCodec.decode(value)];
      }
    } : void 0) as M extends Iterable<[TK, TV]> ? () => IterableIterator<[K, V]> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) ? async function* () {
      for await (const [key, value] of map as AsyncIterable<[TK, TV]>) {
        yield [keyCodec.decode(key), valueCodec.decode(value)];
      }
    } : void 0) as
      M extends (Iterable<[TK, TV]> | AsyncIterable<[TK, TV]>) ? () => AsyncIterableIterator<[K, V]> : undefined;

    const encodeRangeQuery = (options?: RangeQueryOptions<K>): RangeQueryOptions<TK> => {
      return {
        ...options,
        gt: void 0, gte: void 0, lt: void 0, lte: void 0, reverse: false,
        ...(options ? keyCodec.encodeRange ? keyCodec.encodeRange(options) : defaultEncodeRange(this.encodeKey, options) : void 0),
      };
    };

    this.keys = ('keys' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (const key of (map as RangeQueryable<TK, TV>).keys(encodeRangeQuery(options))) {
        yield keyCodec.decode(key);
      }
    } : void 0) as
      M extends RangeQueryable<TK, TV> ? (options?: RangeQueryOptions<K>) => AsyncIterableIterator<K> : undefined;

    this.values = ('values' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (const value of (map as RangeQueryable<TK, TV>).values(encodeRangeQuery(options))) {
        yield valueCodec.decode(value);
      }
    } : void 0) as
      M extends RangeQueryable<TK, TV> ? (options?: RangeQueryOptions<K>) => AsyncIterableIterator<V> : undefined;

    this.entries = ('entries' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (
        const [key, value] of (map as RangeQueryable<TK, TV>).entries(encodeRangeQuery(options))
      ) {
        yield [keyCodec.decode(key), valueCodec.decode(value)];
      }
    } : void 0) as
      M extends RangeQueryable<TK, TV> ? (options?: RangeQueryOptions<K>) => AsyncIterableIterator<[K, V]> : undefined;
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

function defaultEncodeRange<K, TK>(encode: (key: K) => TK, range?: KeyRange<K>): KeyRange<TK> {
  return {
    ...range,
    gt: range?.gt === void 0 ? void 0 : encode(range.gt),
    gte: range?.gte === void 0 ? void 0 : encode(range.gte),
    lt: range?.lt === void 0 ? void 0 : encode(range.lt),
    lte: range?.lte === void 0 ? void 0 : encode(range.lte),
  };
}
