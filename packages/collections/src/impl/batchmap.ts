import { AbortOptions, CodedError, OperationError } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';

/** Abstract base class to provide default synchronous batch API implementations for a {@link MaybeAsyncMap}. */
export abstract class SyncMapBatchAdapter<K, V> implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V> {
  public abstract delete(key: K, options?: AbortOptions): void;
  public abstract get(key: K, options?: AbortOptions): V | undefined;
  public abstract has(key: K, options?: AbortOptions): boolean;
  public abstract set(key: K, value: V, options?: AbortOptions): void;

  public * getMany(keys: Iterable<K>, options?: AbortOptions): IterableIterator<V | undefined> {
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield this.get(key, options);
    }
  }

  public * hasMany(keys: Iterable<K>, options?: AbortOptions): IterableIterator<boolean> {
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield this.has(key, options);
    }
  }

  public * setMany(entries: Iterable<[K, V]>, options?: AbortOptions): IterableIterator<CodedError<K> | undefined> {
    for (const [key, value] of entries) {
      options?.signal?.throwIfAborted();
      try {
        this.set(key, value, options);
        yield;
      } catch (cause) {
        yield new OperationError('failed to set value', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key
        });
      }
    }
  }

  public * deleteMany(keys: Iterable<K>, options?: AbortOptions): IterableIterator<CodedError<K> | undefined> {
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      try {
        this.delete(key, options);
        yield;
      } catch (cause) {
        yield new OperationError('failed to delete key', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key
        });
      }
    }
  }

  public * updateMany(entries: Iterable<[K, V?]>, options?: AbortOptions): IterableIterator<Error | undefined> {
    for (const [key, value] of entries) {
      options?.signal?.throwIfAborted();
      try {
        (value !== void 0) ? this.set(key, value, options) : this.delete(key, options);
        yield;
      } catch (cause) {
        yield new OperationError('failed to update key', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key
        });
      }
    }
  }
}
