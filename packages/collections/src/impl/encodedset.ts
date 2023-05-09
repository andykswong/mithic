import { AbortOptions, CodedError, ErrorCode, MaybePromise, operationError } from '@mithic/commons';
import { MaybeAsyncSet, MaybeAsyncSetBatch } from '../set.js';

/** A set adapter that encodes keys. */
export class EncodedSet<T, U = T> implements MaybeAsyncSet<T>, MaybeAsyncSetBatch<T> {
  public constructor(
    /** The underlying set. */
    public readonly set: MaybeAsyncSet<U> & Partial<MaybeAsyncSetBatch<U>>,
    /** The key encoder. */
    protected readonly encode: (key: T) => U = (key: T) => key as unknown as U,
  ) {
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

  public get [Symbol.toStringTag](): string {
    return EncodedSet.name;
  }
}
