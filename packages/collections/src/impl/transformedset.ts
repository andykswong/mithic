import { AbortOptions, Codec, IdentityCodec, MaybePromise } from '@mithic/commons';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.ts';
import { addMany, deleteMany, hasMany, updateSetMany } from '../utils/batch.ts';
import { KeyValueIterable, RangeQueryOptions, RangeQueryable, rangeQueryable } from '../range.ts';

/**
 * A set adapter that serializes values with a codec.
 * Codec needs to be monotonic to preserve iteration order.
 */
export class TransformedSet<
  T, U = T,
  S extends MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U> & Iterable<U> & AsyncIterable<U> & RangeQueryable<U, U>>
  = MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U> & Iterable<U> & AsyncIterable<U> & RangeQueryable<U, U>>
> implements MaybeAsyncSet<T>, MaybeAsyncSetBatch<T>, Partial<Iterable<T> & AsyncIterable<T> & RangeQueryable<T, T>> {
  public [Symbol.iterator]!: S extends Iterable<U> ? () => IterableIterator<T> : undefined;
  public [Symbol.asyncIterator]!:
    S extends (Iterable<U> | AsyncIterable<U>) ? () => AsyncIterableIterator<T> : undefined;

  public readonly [rangeQueryable]: S extends RangeQueryable<U, U> ? true : undefined;
  public entries: TransformedSetQuery<T, U, S, [T, T]>;
  public keys: TransformedSetQuery<T, U, S, T>;
  public values: TransformedSetQuery<T, U, S, T>;

  public constructor(
    /** Underlying set. */
    public readonly set: S,
    /** Key codec. */
    protected readonly codec: Codec<T, U> = IdentityCodec as Codec<T, U>,
  ) {
    type This = TransformedSet<T, U, S>;

    this[Symbol.iterator] = (Symbol.iterator in set ? function* () {
      for (const key of set as Iterable<U>) {
        yield codec.decode(key);
      }
    } : void 0) as This[typeof Symbol.iterator];

    this[Symbol.asyncIterator] = ((Symbol.iterator in set || Symbol.asyncIterator in set) ? async function* () {
      for await (const key of set as AsyncIterable<U>) {
        yield codec.decode(key);
      }
    } : void 0) as This[typeof Symbol.asyncIterator];

    this[rangeQueryable] = set[rangeQueryable] as This[typeof rangeQueryable];

    this.keys = ('keys' in set ? async function* (options?: RangeQueryOptions<T>) {
      const iter = (set as RangeQueryable<U, U>).keys({
        ...options,
        lower: options?.lower === void 0 ? void 0 : codec.encode(options.lower),
        upper: options?.upper === void 0 ? void 0 : codec.encode(options.upper),
      });
      for await (const key of iter) {
        yield codec.decode(key);
      }
    } : void 0) as This['keys'];

    this.values = this.keys;

    this.entries = (this.keys ? async function* (this: RangeQueryable<T, T>, options?: RangeQueryOptions<T>) {
      for await (const key of this.keys(options)) {
        yield [key, key];
      }
    } : void 0) as This['entries'];
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

/** Query function type for a {@link TransformedSet}. */
export type TransformedSetQuery<T, U, S, E> =
  S extends RangeQueryable<U, U> ? (options?: RangeQueryOptions<T>) => AsyncIterableIterator<E> :
  S extends KeyValueIterable<U, U> ? (options?: AbortOptions) => AsyncIterableIterator<E> : undefined;
