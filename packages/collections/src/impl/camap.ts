import {
  AbortOptions, CodedError, ContentId, InvalidStateError, MaybePromise, OperationError, maybeAsync
} from '@mithic/commons';
import { AutoKeyMap, AutoKeyMapBatch, MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { deleteMany, getMany, hasMany, setMany } from '../utils/batch.js';
import { TransformedMap } from './transformedmap.js';

/** Default CID-based key generation implementation that uses multiformats as optional dependency. */
const [cidHash, decodeCID] = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const { sha256 } = await import('multiformats/hashes/sha2');
    const raw = await import('multiformats/codecs/raw');

    return [
      async function cidHash<Id, T>(value: T): Promise<Id> {
        const bytes = raw.encode(value as unknown as Uint8Array);
        const hash = await sha256.digest(bytes);
        return CID.create(1, raw.code, hash) as unknown as Id;
      },
      function decodeCID<K>(key: string) {
        return CID.parse(key) as unknown as K;
      }
    ];
  } catch (_) {
    const invalid = () => { throw new InvalidStateError('multiformats not available'); };
    return [invalid, invalid];
  }
})();

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
      new TransformedMap<Id, T, string, T, Map<string, T>>(new Map(), {
        encodeKey: (key) => `${key}`,
        decodeKey: decodeCID,
      }) as unknown as M,
    /** Hash function to use for generating keys for values. */
    protected readonly hash: (value: T) => MaybePromise<Id> = cidHash
  ) {
    this[Symbol.iterator] = (Symbol.iterator in map && (() => (map as Iterable<[Id, T]>)[Symbol.iterator]())) as
      M extends Iterable<[Id, T]> ? () => IterableIterator<[Id, T]> : undefined;

    this[Symbol.asyncIterator] = ((Symbol.iterator in map || Symbol.asyncIterator in map) &&
      (() => (map as AsyncIterable<[Id, T]>)[Symbol.asyncIterator]())
    ) as M extends (Iterable<[Id, T]> | AsyncIterable<[Id, T]>) ? () => AsyncIterableIterator<[Id, T]> : undefined;
  }

  public put = maybeAsync(function* (this: ContentAddressedMapStore<Id, T>, value: T, options?: AbortOptions) {
    const cid = yield this.getKey(value);
    yield this.map.set(cid, value, options);
    return cid;
  }, this);

  public delete(key: Id, options?: AbortOptions): MaybePromise<void> {
    return this.map.delete(key, options) as MaybePromise<void>;
  }

  public get(key: Id, options?: AbortOptions): MaybePromise<T | undefined> {
    return this.map.get(key, options);
  }

  public getKey(value: T): MaybePromise<Id> {
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
    const entries = await this.entriesOf(values);
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

  protected async entriesOf(values: Iterable<T>): Promise<[Id, T][]> {
    const entries: [Id, T][] = [];
    for (const value of values) {
      entries.push([await this.getKey(value), value]);
    }
    return entries;
  }
}
