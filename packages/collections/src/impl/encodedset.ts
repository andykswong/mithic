import { AbortOptions, CodedError, ErrorCode, MaybePromise, operationError } from '@mithic/commons';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';

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

  public async * addMany(keys: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    if (this.set.addMany) {
      yield* this.set.addMany([...keys].map(this.encode), options);
      return;
    }

    for (const key of keys) {
      options?.signal?.throwIfAborted();
      try {
        await this.add(key, options);
        yield;
      } catch (error) {
        yield operationError('Failed to add key', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  public async * deleteMany(keys: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    if (this.set.deleteMany) {
      yield* this.set.deleteMany([...keys].map(this.encode), options);
      return;
    }

    for (const key of keys) {
      options?.signal?.throwIfAborted();
      try {
        this.delete(key, options);
        yield;
      } catch (error) {
        yield operationError('Failed to delete key', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  public async * hasMany(keys: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    options?.signal?.throwIfAborted();
    if (this.set.hasMany) {
      yield* this.set.hasMany([...keys].map(this.encode), options);
      return;
    }

    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield this.has(key, options);
    }
  }

  public async * updateMany(
    keys: Iterable<[key: T, isDelete?: boolean]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    if (this.set.updateMany) {
      yield* this.set.updateMany([...keys].map(([key, isDelete]) => [this.encode(key), isDelete]), options);
      return;
    }

    for (const [key, isDelete] of keys) {
      options?.signal?.throwIfAborted();
      try {
        if (isDelete) {
          await this.delete(key, options);
        } else {
          await this.add(key, options);
        }
        yield;
      } catch (error) {
        yield operationError(`Failed to ${isDelete ? 'delete' : 'add'} key`,
          (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  public get [Symbol.toStringTag](): string {
    return EncodedSet.name;
  }
}
