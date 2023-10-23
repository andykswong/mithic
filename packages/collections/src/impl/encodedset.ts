import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';
import { addMany, deleteMany, hasMany, updateSetMany } from '../batch.js';

/** A set adapter that encodes keys. */
export class EncodedSet<
  T, U = T,
  S extends MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U> & Iterable<U> & AsyncIterable<U>>
  = MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U> & Iterable<U> & AsyncIterable<U>>
> implements MaybeAsyncSet<T>, MaybeAsyncSetBatch<T>, Partial<Iterable<T> & AsyncIterable<T>> {
  public [Symbol.iterator]!: S extends Iterable<U> ? () => IterableIterator<T> : undefined;
  public [Symbol.asyncIterator]!:
    S extends (Iterable<U> | AsyncIterable<U>) ? () => AsyncIterableIterator<T> : undefined;

  public constructor(
    /** The underlying set. */
    public readonly set: S,
    /** The key encoder. */
    protected readonly encode: (key: T) => U = (key: T) => key as unknown as U,
    /** The key decoder. Optional if set iteration is not needed. */
    protected readonly decode: (key: U) => T = (key: U) => key as unknown as T,
  ) {
    this[Symbol.iterator] = (Symbol.iterator in set && function* () {
      for (const key of set as Iterable<U>) {
        yield decode(key);
      }
    }) as S extends Iterable<U> ? () => IterableIterator<T> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in set || Symbol.asyncIterator in set) && async function* () {
      for await (const key of set as AsyncIterable<U>) {
        yield decode(key);
      }
    }) as S extends (Iterable<U> | AsyncIterable<U>) ? () => AsyncIterableIterator<T> : undefined;
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
    return EncodedSet.name;
  }
}
