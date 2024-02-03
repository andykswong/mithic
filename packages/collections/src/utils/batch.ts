import { AbortOptions, CodedError, OperationError } from '@mithic/commons';
import {
  MaybeAsyncAppendOnlySet, MaybeAsyncReadonlySet, MaybeAsyncReadonlySetBatch, MaybeAsyncSet, MaybeAsyncSetAddBatch,
  MaybeAsyncSetDeleteBatch, MaybeAsyncSetUpdateBatch
} from '../set.ts';
import { AppendOnlyAutoKeyMap, AutoKeyMapPutBatch, MaybeAsyncMap, MaybeAsyncMapSetBatch, MaybeAsyncMapUpdateBatch, MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch } from '../map.ts';

/** Checks if given keys exist in a set/map. */
export async function* hasMany<K>(
  data: MaybeAsyncReadonlySet<K> & Partial<MaybeAsyncReadonlySetBatch<K>>, keys: Iterable<K>, options?: AbortOptions
): AsyncIterableIterator<boolean> {
  if (data.hasMany) {
    yield* data.hasMany(keys, options);
    return;
  }
  for (const key of keys) {
    options?.signal?.throwIfAborted();
    yield data.has(key, options);
  }
}

/** Gets the list of data identified by given keys from map. */
export async function* getMany<K, V>(
  data: MaybeAsyncReadonlyMap<K, V> & Partial<MaybeAsyncReadonlyMapBatch<K, V>>, keys: Iterable<K>, options?: AbortOptions
): AsyncIterableIterator<V | undefined> {
  if (data.getMany) {
    yield* data.getMany(keys, options);
    return;
  }
  for (const key of keys) {
    options?.signal?.throwIfAborted();
    yield data.get(key, options);
  }
}

/** Deletes the given keys from map/set. */
export async function* deleteMany<K>(
  data: (MaybeAsyncSet<K> | MaybeAsyncMap<K, unknown>) & Partial<MaybeAsyncSetDeleteBatch<K>>,
  keys: Iterable<K>,
  options?: AbortOptions
): AsyncIterableIterator<Error | undefined> {
  if (data.deleteMany) {
    yield* data.deleteMany(keys, options);
    return;
  }
  for (const key of keys) {
    options?.signal?.throwIfAborted();
    try {
      await data.delete(key, options);
      yield;
    } catch (cause) {
      yield new OperationError('failed to delete key', {
        cause,
        code: (cause as CodedError)?.code,
        detail: key,
      });
    }
  }
}

/** Adds the given keys to set. */
export async function* addMany<K>(
  data: MaybeAsyncAppendOnlySet<K> & Partial<MaybeAsyncSetAddBatch<K>>, keys: Iterable<K>, options?: AbortOptions
): AsyncIterableIterator<Error | undefined> {
  if (data.addMany) {
    yield* data.addMany(keys, options);
    return;
  }
  for (const key of keys) {
    options?.signal?.throwIfAborted();
    try {
      await data.add(key, options);
      yield;
    } catch (cause) {
      yield new OperationError('failed to add key', {
        cause,
        code: (cause as CodedError)?.code,
        detail: key,
      });
    }
  }
}

/** Sets the given entries to map. */
export async function* setMany<K, V>(
  data: MaybeAsyncMap<K, V> & Partial<MaybeAsyncMapSetBatch<K, V>>, entries: Iterable<[K, V]>, options?: AbortOptions
): AsyncIterableIterator<Error | undefined> {
  if (data.setMany) {
    yield* data.setMany(entries, options);
    return;
  }
  for (const [key, value] of entries) {
    options?.signal?.throwIfAborted();
    try {
      await data.set(key, value, options);
      yield;
    } catch (cause) {
      yield new OperationError('failed to set key', {
        cause,
        code: (cause as CodedError)?.code,
        detail: key,
      });
    }
  }
}

/** Adds or deletes given keys from set. */
export async function* updateSetMany<K>(
  data: MaybeAsyncSet<K> & Partial<MaybeAsyncSetUpdateBatch<K>>,
  keys: Iterable<[key: K, isAdd?: boolean]>,
  options?: AbortOptions
): AsyncIterableIterator<Error | undefined> {
  if (data.updateMany) {
    yield* data.updateMany(keys, options);
    return;
  }
  for (const [key, isAdd] of keys) {
    options?.signal?.throwIfAborted();
    try {
      await (isAdd ? data.add(key, options) : data.delete(key, options));
      yield;
    } catch (cause) {
      yield new OperationError(`failed to update key`, {
        cause,
        code: (cause as CodedError)?.code,
        detail: key,
      });
    }
  }
}

/** Sets or deletes given entries from map. */
export async function* updateMapMany<K, V>(
  data: MaybeAsyncMap<K, V> & Partial<MaybeAsyncMapUpdateBatch<K, V>>,
  entries: Iterable<[K, V?]>, options?: AbortOptions
): AsyncIterableIterator<Error | undefined> {
  if (data.updateMany) {
    yield* data.updateMany(entries, options);
    return;
  }
  for (const [key, value] of entries) {
    options?.signal?.throwIfAborted();
    try {
      await ((value !== void 0) ? data.set(key, value, options) : data.delete(key, options));
      yield;
    } catch (cause) {
      yield new OperationError('failed to update key', {
        cause,
        code: (cause as CodedError)?.code,
        detail: key,
      });
    }
  }
}

/** Puts the given values to map. */
export async function* putMany<K, V>(
  data: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapPutBatch<K, V>>, values: Iterable<V>, options?: AbortOptions
): AsyncIterableIterator<[key: K, error?: Error]> {
  if (data.putMany) {
    yield* data.putMany(values, options);
    return;
  }
  for (const value of values) {
    options?.signal?.throwIfAborted();
    try {
      yield [await data.put(value, options)];
    } catch (cause) {
      const key = await data.getKey(value, options);
      yield [
        key,
        new OperationError('failed to put key', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key,
        })
      ];
    }
  }
}
