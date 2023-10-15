import {
  AbortOptions, CodedError, ContentId, MaybePromise, OperationError, maybeAsync, sha256
} from '@mithic/commons';
import { CID } from 'multiformats';
import * as raw from 'multiformats/codecs/raw';
import { AutoKeyMap, AutoKeyMapBatch, MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { EncodedMap } from './encodedmap.js';
import { deleteMany, getMany, hasMany, setMany } from '../batch.js';

/** A content-addressable map store that persists values in a backing {@link MaybeAsyncMap}. */
export class ContentAddressedMapStore<
  Id = ContentId, T = Uint8Array,
  M extends MaybeAsyncMap<Id, T> & Partial<MaybeAsyncMapBatch<Id, T> & Iterable<[Id, T]> & AsyncIterable<[Id, T]>>
  = MaybeAsyncMap<Id, T> & Partial<MaybeAsyncMapBatch<Id, T> & Iterable<[Id, T]> & AsyncIterable<[Id, T]>>
> implements AutoKeyMap<Id, T>, AutoKeyMapBatch<Id, T>, Partial<Iterable<[Id, T]> & AsyncIterable<[Id, T]>>
{
  public [Symbol.iterator]!: M extends Iterable<[Id, T]> ? () => IterableIterator<[Id, T]> : undefined;
  public [Symbol.asyncIterator]!:
    M extends (Iterable<[Id, T]> | AsyncIterable<[Id, T]>) ? () => AsyncIterableIterator<[Id, T]> : undefined;

  public constructor(
    /** The underlying map. */
    public readonly map: M =
      new EncodedMap<Id, T, string, T, Map<string, T>>(new Map(), {
        encodeKey: (key) => `${key}`,
        decodeKey: (key) => CID.parse(key) as Id
      }) as unknown as M,
    /** Hash function to use for generating keys for values. */
    protected readonly hash: (value: T) => Id = defaultHasher as unknown as (value: T) => Id
  ) {
    this[Symbol.iterator] = (Symbol.iterator in map && (() => (map as Iterable<[Id, T]>)[Symbol.iterator]())) as
      M extends Iterable<[Id, T]> ? () => IterableIterator<[Id, T]> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) &&
      (() => (map as AsyncIterable<[Id, T]>)[Symbol.asyncIterator]())
    ) as M extends (Iterable<[Id, T]> | AsyncIterable<[Id, T]>) ? () => AsyncIterableIterator<[Id, T]> : undefined;
  }

  public put = maybeAsync(function* (this: ContentAddressedMapStore<Id, T>, value: T, options?: AbortOptions) {
    const cid = this.getKey(value);
    yield this.map.set(cid, value, options);
    return cid;
  }, this);

  public delete(key: Id, options?: AbortOptions): MaybePromise<void> {
    return this.map.delete(key, options) as MaybePromise<void>;
  }

  public get(key: Id, options?: AbortOptions): MaybePromise<T | undefined> {
    return this.map.get(key, options);
  }

  public getKey(value: T): Id {
    return this.hash(value);
  }

  public has(key: Id, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(key, options);
  }

  public deleteMany(keys: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    return deleteMany(this.map, keys, options);
  }

  public async * putMany(
    values: Iterable<T>, options?: AbortOptions
  ): AsyncIterableIterator<[key: Id, error?: CodedError]> {
    const entries = this.entriesOf(values);
    let i = 0;
    for await (const error of setMany(this.map, entries, options)) {
      const key = entries[i++][0];
      yield [
        key,
        error && new OperationError('failed to put', {
          code: (error as CodedError)?.code,
          detail: key,
          cause: error
        })
      ];
    }
  }

  public getMany(keys: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<T | undefined> {
    return getMany(this.map, keys, options);
  }

  public hasMany(keys: Iterable<Id>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return hasMany(this.map, keys, options);
  }

  public get [Symbol.toStringTag](): string {
    return ContentAddressedMapStore.name;
  }

  protected entriesOf(values: Iterable<T>): [Id, T][] {
    const entries: [Id, T][] = [];
    for (const value of values) {
      entries.push([this.getKey(value), value]);
    }
    return entries;
  }
}

function defaultHasher(value: Uint8Array): CID {
  const bytes = raw.encode(value);
  const hash = sha256.digest(bytes);
  return CID.create(1, raw.code, hash);
}
