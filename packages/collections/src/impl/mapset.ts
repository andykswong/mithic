import { AbortOptions, Codec, MaybePromise } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { KeyValueIterable, RangeQueryOptions, RangeQueryable, rangeQueryable } from '../range.js';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';
import { deleteMany, hasMany, setMany, updateMapMany } from '../utils/batch.js';
import { BTreeMap } from './btreemap.js';

/** A set that stores data in a {@link MaybeAsyncMap}. */
export class MapSet<K, MK = K, MV = K, M extends MapSetBackingMap<MK, MV> = MapSetBackingMap<MK, MV>>
  implements MaybeAsyncSet<K>, MaybeAsyncSetBatch<K>, Partial<Iterable<K> & AsyncIterable<K> & RangeQueryable<K, K>>
{
  public [Symbol.iterator]!: M extends Iterable<[MK, MV]> ? () => IterableIterator<K> : undefined;
  public [Symbol.asyncIterator]!:
    M extends (Iterable<[MK, MV]> | AsyncIterable<[MK, MV]>) ? () => AsyncIterableIterator<K> : undefined;

  public readonly [rangeQueryable]: M extends RangeQueryable<MK, MV> ? true : undefined;
  public entries: MapSetQuery<[K, K], K, MK, MV, M>;
  public keys: MapSetQuery<K, K, MK, MV, M>;
  public values: MapSetQuery<K, K, MK, MV, M>;

  public constructor(
    /** Underlying map. */
    public readonly map: M,
    /** The codec to convert keys to map entries. */
    protected readonly codec: Codec<K, [MK, MV]> = {
      encode: (key) => [key, key] as unknown as [MK, MV],
      decode: ([key]) => key as unknown as K,
    }
  ) {
    type This = MapSet<K, MK, MV, M>;

    this[Symbol.iterator] = (Symbol.iterator in map ? function* () {
      for (const entry of map as Iterable<[MK, MV]>) { yield codec.decode(entry); }
    } : void 0) as This[typeof Symbol.iterator];

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) ? async function* () {
      for await (const entry of map as AsyncIterable<[MK, MV]>) { yield codec.decode(entry); }
    } : void 0) as This[typeof Symbol.asyncIterator];

    this[rangeQueryable] = map[rangeQueryable] as This[typeof rangeQueryable];

    this.keys = ('keys' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (const entry of (map as RangeQueryable<MK, MV>).entries({
        ...options,
        lower: options?.lower !== void 0 ? codec.encode(options.lower)[0] : void 0,
        upper: options?.upper !== void 0 ? codec.encode(options.upper)[0] : void 0,
      })) {
        yield codec.decode(entry);
      }
    } : void 0) as This['keys'];

    this.values = this.keys;

    this.entries = (this.keys ? async function* (this: RangeQueryable<K, K>, options?: RangeQueryOptions<K>) {
      for await (const key of this.keys(options)) {
        yield [key, key];
      }
    } : void 0) as This['entries'];
  }

  public add(key: K, options?: AbortOptions): MaybePromise<unknown> {
    const [mk, mv] = this.codec.encode(key);
    return this.map.set(mk, mv, options);
  }

  public delete(key: K, options?: AbortOptions): MaybePromise<unknown> {
    return this.map.delete(this.codec.encode(key)[0], options);
  }

  public has(key: K, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(this.codec.encode(key)[0], options);
  }

  public addMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return setMany(this.map, [...keys].map((key) => this.codec.encode(key)), options);
  }

  public deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return deleteMany(this.map, [...keys].map((key) => this.codec.encode(key)[0]), options);
  }

  public hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return hasMany(this.map, [...keys].map((key) => this.codec.encode(key)[0]), options);
  }

  public updateMany(
    keys: Iterable<[key: K, isAdd?: boolean]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    return updateMapMany(this.map, [...keys].map(([key, isAdd]) => {
      const entry = this.codec.encode(key);
      return isAdd ? entry : [entry[0]];
    }), options);
  }

  public get [Symbol.toStringTag](): string {
    return MapSet.name;
  }
}

/** Backing map type for {@link MapSet}. */
export type MapSetBackingMap<K, V> = MaybeAsyncMap<K, V> &
  Partial<MaybeAsyncMapBatch<K, V> & Iterable<[K, V]> & AsyncIterable<[K, V]> & RangeQueryable<K, V>>;

/** Query function type for a {@link MapSet}. */
export type MapSetQuery<E, K, MK, MV, M> =
  M extends RangeQueryable<MK, MV> ? (options?: RangeQueryOptions<K>) => AsyncIterableIterator<E> :
  M extends KeyValueIterable<MK, MV> ? (options?: AbortOptions) => AsyncIterableIterator<E> : undefined;

/** A {@link MapSet} backed by {@link BTreeMap}. */
export class BTreeSet<K> extends MapSet<K, K, K, BTreeMap<K, K>> {
  public constructor(
    /** Order of the tree, which is the maximum branching factor / number of children of a node. Must be >= 2. */
    public readonly order?: number,
    /** Function that defines the sort order of keys. */
    protected readonly compare?: (a: K, b: K) => number,
  ) {
    super(new BTreeMap(order, compare));
  }

  /** Returns the number of elements in the tree. */
  public get size(): number {
    return this.map.size;
  }

  public get [Symbol.toStringTag](): string {
    return BTreeSet.name;
  }
}
