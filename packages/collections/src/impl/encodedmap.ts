import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { deleteMany, getMany, hasMany, setMany, updateMapMany } from '../batch.js';

/** A map adapter that encodes keys and/or values. */
export class EncodedMap<
  K, V, TK = K, TV = V,
  M extends MaybeAsyncMap<TK, TV> & Partial<MaybeAsyncMapBatch<TK, TV> & Iterable<[TK, TV]> & AsyncIterable<[TK, TV]>>
  = MaybeAsyncMap<TK, TV> & Partial<MaybeAsyncMapBatch<TK, TV> & Iterable<[TK, TV]> & AsyncIterable<[TK, TV]>>
> implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, Partial<Iterable<[K, V]> & AsyncIterable<[K, V]>> {
  protected readonly encodeKey: (key: K) => TK;
  protected readonly decodeKey: (key: TK) => K;
  protected readonly encodeValue: (value: V) => TV;
  protected readonly decodeValue: (value: TV) => V;

  public [Symbol.iterator]!: M extends Iterable<[TK, TV]> ? () => IterableIterator<[K, V]> : undefined;
  public [Symbol.asyncIterator]!:
    M extends (Iterable<[TK, TV]> | AsyncIterable<[TK, TV]>) ? () => AsyncIterableIterator<[K, V]> : undefined;

  public constructor(
    /** The underlying map. */
    public readonly map: M,
    {
      encodeKey = (key: K) => key as unknown as TK,
      decodeKey = (key: TK) => key as unknown as K,
      encodeValue = (value: V) => value as unknown as TV,
      decodeValue = (value: TV) => value as unknown as V,
    }: EncodedMapOptions<K, V, TK, TV> = {}
  ) {
    this.encodeKey = encodeKey;
    this.decodeKey = decodeKey;
    this.encodeValue = encodeValue;
    this.decodeValue = decodeValue;

    this[Symbol.iterator] = (Symbol.iterator in map && function* () {
      for (const [key, value] of map as Iterable<[TK, TV]>) {
        yield [decodeKey(key), decodeValue(value)];
      }
    }) as M extends Iterable<[TK, TV]> ? () => IterableIterator<[K, V]> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) && async function* () {
      for await (const [key, value] of map as AsyncIterable<[TK, TV]>) {
        yield [decodeKey(key), decodeValue(value)];
      }
    }) as M extends (Iterable<[TK, TV]> | AsyncIterable<[TK, TV]>) ? () => AsyncIterableIterator<[K, V]> : undefined;
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
    for await (const value of getMany(this.map, [...keys].map(this.encodeKey), options)) {
      options?.signal?.throwIfAborted();
      yield this.decodeOptionalValue(value);
    }
  }

  public hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return hasMany(this.map, [...keys].map(this.encodeKey), options);
  }

  public setMany(entries: Iterable<[K, V]>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return setMany(
      this.map, [...entries].map(([key, value]) => [this.encodeKey(key), this.encodeValue(value)]), options
    );
  }

  public deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return deleteMany(this.map, [...keys].map(this.encodeKey), options);
  }

  public updateMany(
    entries: Iterable<[K, V?]>, options?: AbortOptions
  ): AsyncIterableIterator<Error | undefined> {
    return updateMapMany(
      this.map,
      [...entries].map(
        ([key, value]) => [this.encodeKey(key), value === void 0 ? void 0 : this.encodeValue(value)]
      ),
      options
    );
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

  /** The key decoder. Optional if map key iteration is not needed. */
  decodeKey?: (key: TK) => K;

  /** The value encoder. */
  encodeValue?: (value: V) => TV;

  /** The value decoder. */
  decodeValue?: (value: TV) => V;
}
