import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { KeyValueIterable, RangeQueryOptions, RangeQueryable, rangeQueryable } from '../range.js';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';
import { deleteMany, hasMany, setMany, updateMapMany } from '../utils/batch.js';
import { BTreeMap } from './btreemap.js';

/** A set that stores data in a {@link MaybeAsyncMap}. */
export class MapSet<
  K, V = K,
  M extends MaybeAsyncMap<K, V> & Partial<MaybeAsyncMapBatch<K, V> & Iterable<[K, V]> & AsyncIterable<[K, V]> & RangeQueryable<K, V>>
  = MaybeAsyncMap<K, V> & Partial<MaybeAsyncMapBatch<K, V> & Iterable<[K, V]> & AsyncIterable<[K, V]> & RangeQueryable<K, V>>
> implements MaybeAsyncSet<K>, MaybeAsyncSetBatch<K>, Partial<Iterable<K> & AsyncIterable<K> & RangeQueryable<K, K>> {
  public [Symbol.iterator]!: M extends Iterable<[K, V]> ? () => IterableIterator<K> : undefined;
  public [Symbol.asyncIterator]!:
    M extends (Iterable<[K, V]> | AsyncIterable<[K, V]>) ? () => AsyncIterableIterator<K> : undefined;

  public readonly [rangeQueryable]: M extends RangeQueryable<K, V> ? true : undefined;
  public entries: MapSetQuery<K, V, M, [K, K]>;
  public keys: MapSetQuery<K, V, M, K>;
  public values: MapSetQuery<K, V, M, K>;

  public constructor(
    /** Underlying map. */
    public readonly map: M,
    /** The value to use for map entries. */
    protected readonly value: (key: K) => V = (k) => k as unknown as V,
  ) {
    type This = MapSet<K, V, M>;

    this[Symbol.iterator] = (Symbol.iterator in map ? function* () {
      for (const [key] of map as Iterable<[K, V]>) { yield key; }
    } : void 0) as This[typeof Symbol.iterator];

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) ? async function* () {
      for await (const [key] of map as AsyncIterable<[K, V]>) { yield key; }
    } : void 0) as This[typeof Symbol.asyncIterator];

    this[rangeQueryable] = map[rangeQueryable] as This[typeof rangeQueryable];

    this.keys = ('keys' in map ? async function* (options?: RangeQueryOptions<K>) {
      for await (const key of (map as RangeQueryable<K, V>).keys(options)) {
        yield key;
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
    return this.map.set(key, this.value(key), options);
  }

  public delete(key: K, options?: AbortOptions): MaybePromise<unknown> {
    return this.map.delete(key, options);
  }

  public has(key: K, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(key, options);
  }

  public addMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return setMany(this.map, [...keys].map((key) => [key, this.value(key)]), options);
  }

  public deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return deleteMany(this.map, keys, options);
  }

  public hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return hasMany(this.map, keys, options);
  }

  public updateMany(
    keys: Iterable<[key: K, isAdd?: boolean]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    return updateMapMany(this.map, [...keys].map(([key, isAdd]) => isAdd ? [key, this.value(key)] : [key]), options);
  }

  public get [Symbol.toStringTag](): string {
    return MapSet.name;
  }
}

/** Query function type for a {@link MapSet}. */
export type MapSetQuery<K, V, M, E> =
  M extends RangeQueryable<K, V> ? (options?: RangeQueryOptions<K>) => AsyncIterableIterator<E> :
  M extends KeyValueIterable<K, V> ? (options?: AbortOptions) => AsyncIterableIterator<E> : undefined;

/** A {@link MapSet} backed by {@link BTreeMap}. */
export class BTreeSet<K> extends MapSet<K, K, BTreeMap<K, K>> {
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
