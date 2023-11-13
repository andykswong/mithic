import { AbortOptions, IdentityCodec, MaybePromise } from '@mithic/commons';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';
import { addMany, deleteMany, hasMany, updateSetMany } from '../utils/batch.js';
import { KeyRange, RangeKeyCodec, RangeQueryOptions, RangeQueryable } from '../query.js';

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
    /** Underlying set. */
    public readonly set: S,
    /** Key codec. */
    protected readonly codec: RangeKeyCodec<T, U> = IdentityCodec as RangeKeyCodec<T, U>,
  ) {
    this[Symbol.iterator] = (Symbol.iterator in set ? function* () {
      for (const key of set as Iterable<U>) {
        yield codec.decode(key);
      }
    } : void 0) as S extends Iterable<U> ? () => IterableIterator<T> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in set || Symbol.asyncIterator in set) ? async function* () {
      for await (const key of set as AsyncIterable<U>) {
        yield codec.decode(key);
      }
    } : void 0) as S extends (Iterable<U> | AsyncIterable<U>) ? () => AsyncIterableIterator<T> : undefined;

    const encodeRangeQuery = (options?: RangeQueryOptions<T>): RangeQueryOptions<U> => {
      return {
        ...options,
        gt: void 0, gte: void 0, lt: void 0, lte: void 0, reverse: false,
        ...(options ? codec.encodeRange ? codec.encodeRange(options) : defaultEncodeRange(this.encode, options) : void 0),
      };
    };

    this.keys = ('keys' in set ? async function* (options?: RangeQueryOptions<T>) {
      for await (const key of (set as RangeQueryable<U, U>).keys(encodeRangeQuery(options))) {
        yield codec.decode(key);
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
    return this.set.add(this.codec.encode(value), options);
  }

  public delete(value: T, options?: AbortOptions): MaybePromise<unknown> {
    return this.set.delete(this.codec.encode(value), options);
  }

  public has(value: T, options?: AbortOptions): MaybePromise<boolean> {
    return this.set.has(this.codec.encode(value), options);
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
    return updateSetMany(this.set, [...keys].map(([key, isAdd]) => [this.codec.encode(key), isAdd]), options);
  }

  public get [Symbol.toStringTag](): string {
    return TransformedSet.name;
  }

  protected encode = (key: T) => this.codec.encode(key);
}

function defaultEncodeRange<T, U>(encode: (key: T) => U, range?: KeyRange<T>): KeyRange<U> {
  return {
    ...range,
    gt: range?.gt === void 0 ? void 0 : encode(range.gt),
    gte: range?.gte === void 0 ? void 0 : encode(range.gte),
    lt: range?.lt === void 0 ? void 0 : encode(range.lt),
    lte: range?.lte === void 0 ? void 0 : encode(range.lte),
  };
}
