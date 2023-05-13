import { AbortOptions, CodedError, ErrorCode, MaybePromise, operationError } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';

/** A map adapter that encodes keys and/or values. */
export class EncodedMap<K, V, TK = K, TV = V> implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V> {
  protected encodeKey: (key: K) => TK;
  protected encodeValue: (value: V) => TV;
  protected decodeValue: (value: TV) => V;

  public constructor(
    /** The underlying map. */
    public readonly map: MaybeAsyncMap<TK, TV> & Partial<MaybeAsyncMapBatch<TK, TV>>,
    {
      encodeKey = (key: K) => key as unknown as TK,
      encodeValue = (value: V) => value as unknown as TV,
      decodeValue = (value: TV) => value as unknown as V,
    }: EncodedMapOptions<K, V, TK, TV> = {}
  ) {
    this.encodeKey = encodeKey;
    this.encodeValue = encodeValue;
    this.decodeValue = decodeValue;
  }

  public get(key: K, options?: AbortOptions): MaybePromise<V | undefined> {
    return MaybePromise.map(this.map.get(this.encodeKey(key), options), this.decodeOptionalValue);
  }

  public set(key: K, value: V, options?: AbortOptions): MaybePromise<unknown> {
    return this.map.set(this.encodeKey(key), this.encodeValue(value), options);
  }

  public delete(key: K, options?: AbortOptions): MaybePromise<unknown> {
    return this.map.delete(this.encodeKey(key), options);
  }

  public has(key: K, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(this.encodeKey(key), options);
  }

  public async * getMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    options?.signal?.throwIfAborted();
    if (this.map.getMany) {
      for await (const value of this.map.getMany([...keys].map(this.encodeKey), options)) {
        options?.signal?.throwIfAborted();
        yield this.decodeOptionalValue(value);
      }
      return;
    }

    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield this.get(key, options);
    }
  }

  public async * hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    options?.signal?.throwIfAborted();
    if (this.map.hasMany) {
      yield* this.map.hasMany([...keys].map(this.encodeKey), options);
      return;
    }

    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield this.has(key, options);
    }
  }

  public async * setMany(entries: Iterable<[K, V]>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    if (this.map.setMany) {
      yield* this.map.setMany([...entries].map(([key, value]) => [this.encodeKey(key), this.encodeValue(value)]), options);
      return;
    }

    for (const [key, value] of entries) {
      options?.signal?.throwIfAborted();
      try {
        await this.set(key, value, options);
        yield;
      } catch (error) {
        yield operationError('Failed to set value', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  public async * deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    if (this.map.deleteMany) {
      yield* this.map.deleteMany([...keys].map(this.encodeKey), options);
      return;
    }

    for (const key of keys) {
      options?.signal?.throwIfAborted();
      try {
        await this.delete(key, options);
        yield;
      } catch (error) {
        yield operationError('Failed to delete key', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  public async * updateMany(
    entries: Iterable<[K, V | undefined]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    if (this.map.updateMany) {
      yield* this.map.updateMany(
        [...entries].map(
          ([key, value]) => [this.encodeKey(key), value === void 0 ? void 0 : this.encodeValue(value)]
        ),
        options
      );
      return;
    }

    for (const [key, value] of entries) {
      options?.signal?.throwIfAborted();
      try {
        if (value !== void 0) {
          await this.set(key, value, options);
        } else {
          await this.delete(key, options);
        }
        yield;
      } catch (error) {
        yield operationError('Failed to update value', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }


  public get [Symbol.toStringTag](): string {
    return EncodedMap.name;
  }

  private decodeOptionalValue = (value?: TV): V | undefined => {
    return value === void 0 ? void 0 : this.decodeValue(value);
  };
}

/** Options for creating an {@link EncodedMap}. */
export interface EncodedMapOptions<K, V, TK, TV> {
  /** The key encoder. */
  encodeKey?: (key: K) => TK;

  /** The value encoder. */
  encodeValue?: (value: V) => TV;

  /** The value decoder. */
  decodeValue?: (value: TV) => V;
}
