import { AbortOptions, CodedError, ErrorCode, operationError } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';

/** Abstract base class to provide default synchronous batch API implementations for a {@link MaybeAsyncMap}. */
export abstract class SyncMapBatchAdapter<K, V> implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V> {
  public abstract delete(key: K, options?: AbortOptions): void;
  public abstract get(key: K, options?: AbortOptions): V | undefined;
  public abstract has(key: K, options?: AbortOptions): boolean;
  public abstract set(key: K, value: V, options?: AbortOptions): void;

  public * getMany(keys: Iterable<K>, options?: AbortOptions): IterableIterator<V | undefined> {
    for (const key of keys) {
      yield this.get(key, options);
    }
  }

  public * hasMany(keys: Iterable<K>, options?: AbortOptions): IterableIterator<boolean> {
    for (const key of keys) {
      yield this.has(key, options);
    }
  }

  public * setMany(entries: Iterable<[K, V]>, options?: AbortOptions): IterableIterator<CodedError<K> | undefined> {
    for (const [key, value] of entries) {
      try {
        this.set(key, value, options);
        yield;
      } catch (error) {
        yield operationError('Failed to set value', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  public * deleteMany(keys: Iterable<K>, options?: AbortOptions): IterableIterator<CodedError<K> | undefined> {
    for (const key of keys) {
      try {
        this.delete(key, options);
        yield;
      } catch (error) {
        yield operationError('Failed to delete key', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }
}
