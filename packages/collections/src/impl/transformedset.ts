import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';
import { addMany, deleteMany, hasMany, updateSetMany } from '../utils/batch.js';
import { RangeQueryOptions, RangeQueryable } from '../query.js';

/** A set adapter that transforms keys. */
export class TransformedSet<
  T, U = T,
  S extends MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U> & Iterable<U> & AsyncIterable<U> & RangeQueryable<U, U>>
  = MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U> & Iterable<U> & AsyncIterable<U> & RangeQueryable<U, U>>
> implements MaybeAsyncSet<T>, MaybeAsyncSetBatch<T>, Partial<Iterable<T> & AsyncIterable<T> & RangeQueryable<T, T>> {
  public [Symbol.iterator]!: S extends Iterable<U> ? () => IterableIterator<T> : undefined;
  public [Symbol.asyncIterator]!:
    S extends (Iterable<U> | AsyncIterable<U>) ? () => AsyncIterableIterator<T> : undefined;
  public entries: S extends RangeQueryable<U, U> ?
    (options?: RangeQueryOptions<T>) => AsyncIterableIterator<[T, T]> : undefined;
  public keys: S extends RangeQueryable<U, U> ?
    (options?: RangeQueryOptions<T>) => AsyncIterableIterator<T> : undefined;
  public values: S extends RangeQueryable<U, U> ?
    (options?: RangeQueryOptions<T>) => AsyncIterableIterator<T> : undefined;

  public constructor(
    /** The underlying set. */
    public readonly set: S,
    /** The key encoder. */
    protected readonly encode: (key: T) => U = (key: T) => key as unknown as U,
    /** The key decoder. Optional if set iteration is not needed. */
    protected readonly decode: (key: U) => T = (key: U) => key as unknown as T,
  ) {
    this[Symbol.iterator] = (Symbol.iterator in set ? function* () {
      for (const key of set as Iterable<U>) {
        yield decode(key);
      }
    } : void 0) as S extends Iterable<U> ? () => IterableIterator<T> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in set || Symbol.asyncIterator in set) ? async function* () {
      for await (const key of set as AsyncIterable<U>) {
        yield decode(key);
      }
    } : void 0) as S extends (Iterable<U> | AsyncIterable<U>) ? () => AsyncIterableIterator<T> : undefined;

    this.keys = ('keys' in set ? async function* (options?: RangeQueryOptions<T>) {
      for await (const key of (set as RangeQueryable<U, U>).keys({
        ...options,
        gt: options?.gt === void 0 ? void 0 : encode(options.gt),
        gte: options?.gte === void 0 ? void 0 : encode(options.gte),
        lt: options?.lt === void 0 ? void 0 : encode(options.lt),
        lte: options?.lte === void 0 ? void 0 : encode(options.lte),
      })) {
        yield decode(key);
      }
    } : void 0) as
      S extends RangeQueryable<U, U> ? (options?: RangeQueryOptions<T>) => AsyncIterableIterator<T> : undefined;

    this.values = this.keys;

    this.entries = (this.keys ? async function* (this: RangeQueryable<T, T>, options?: RangeQueryOptions<T>) {
      for await (const key of this.keys(options)) {
        yield [key, key];
      }
    } : void 0) as
      S extends RangeQueryable<U, U> ? (options?: RangeQueryOptions<T>) => AsyncIterableIterator<[T, T]> : undefined;
  }

  public add(value: T, options?: AbortOptions): MaybePromise<unknown> {
    return this.set.add(this.encode(value), options);
  }

  public delete(value: T, options?: AbortOptions): MaybePromise<unknown> {
    return this.set.delete(this.encode(value), options);
  }

  public has(value: T, options?: AbortOptions): MaybePromise<boolean> {
    return this.set.has(this.encode(value), options);
  }

  public addMany(keys: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return addMany(this.set, [...keys].map(this.encode), options);
  }

  public deleteMany(keys: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return deleteMany(this.set, [...keys].map(this.encode), options);
  }

  public hasMany(keys: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return hasMany(this.set, [...keys].map(this.encode), options);
  }

  public updateMany(
    keys: Iterable<[key: T, isAdd?: boolean]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    return updateSetMany(this.set, [...keys].map(([key, isAdd]) => [this.encode(key), isAdd]), options);
  }

  public get [Symbol.toStringTag](): string {
    return TransformedSet.name;
  }
}
