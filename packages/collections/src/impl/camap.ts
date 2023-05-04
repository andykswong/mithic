import {
  AbortOptions, ContentId, MaybePromise, maybeAsync, sha256, CodedError, MaybeAsyncIterableIterator,
  operationError, ErrorCode
} from '@mithic/commons';
import { BlockCodec, CID, SyncMultihashHasher } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import * as raw from 'multiformats/codecs/raw';
import { AutoKeyMap, AutoKeyMapBatch, MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { HashMap } from './hashmap.js';

/**
 * A content-addressable map store that persists values in a backing {@link MaybeAsyncMap}.
 */
export class ContentAddressedMapStore<T = Uint8Array>
  implements AutoKeyMap<ContentId, T>, AutoKeyMapBatch<ContentId, T>
{
  public constructor(
    /** The underlying storage. */
    protected readonly map: MaybeAsyncMap<ContentId, T> & Partial<MaybeAsyncMapBatch<ContentId, T>>
      = new HashMap<ContentId, T>(new Map(), (cid) => cid.toString(base64)),
    /** Data binary encoding to use. */
    protected readonly blockCodec: BlockCodec<number, T> = raw as unknown as BlockCodec<number, T>,
    /** Hash function to use for generating CIDs for block data. */
    protected readonly hasher: SyncMultihashHasher<number> = sha256
  ) {
  }

  public put = maybeAsync(function* (this: ContentAddressedMapStore<T>, block: T, options?: AbortOptions) {
    const cid = this.getCID(block);
    yield this.map.set(cid, block, options);
    return cid;
  }, this);

  public delete(cid: ContentId, options?: AbortOptions): MaybePromise<void> {
    return this.map.delete(cid, options) as MaybePromise<void>;
  }

  public get(cid: ContentId, options?: AbortOptions): MaybePromise<T | undefined> {
    return this.map.get(cid, options);
  }

  public has(cid: ContentId, options?: AbortOptions): MaybePromise<boolean> {
    return this.map.has(cid, options);
  }

  public deleteMany(keys: Iterable<ContentId>, options?: AbortOptions): MaybeAsyncIterableIterator<Error | undefined> {
    return this.map.deleteMany ? this.map.deleteMany(keys, options) : this.deleteEach(keys, options);
  }

  public async * putMany(
    values: Iterable<T>, options?: AbortOptions
  ): AsyncIterableIterator<[key: ContentId, error?: CodedError]> {
    if (this.map.setMany) {
      const entries = this.entriesOf(values);
      let i = 0;
      for await (const error of this.map.setMany(entries, options)) {
        const key = entries[i++][0];
        yield [
          key,
          error && operationError(
            'Failed to put',
            (error as CodedError)?.code ?? ErrorCode.OpFailed,
            key,
            error
          )
        ];
      }
    } else {
      for (const value of values) {
        const key = this.getCID(value);
        try {
          await this.map.set(key, value, options);
          yield [key];
        } catch (error) {
          yield [
            key,
            operationError('Failed to put', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error)
          ];
        }
      }
    }
  }

  public async * getMany(cids: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<T | undefined> {
    if (this.map.getMany) {
      return yield* this.map.getMany(cids, options);
    } else {
      for (const cid of cids) {
        yield this.get(cid, options);
      }
    }
  }

  public async * hasMany(cids: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    if (this.map.hasMany) {
      return yield* this.map.hasMany(cids, options);
    } else {
      for (const cid of cids) {
        yield this.has(cid, options);
      }
    }
  }

  public get [Symbol.toStringTag](): string {
    return ContentAddressedMapStore.name;
  }

  protected async * deleteEach(keys: Iterable<ContentId>, options?: AbortOptions) {
    for (const key of keys) {
      try {
        await this.delete(key, options);
        yield;
      } catch (error) {
        yield operationError('Failed to delete', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
    }
  }

  protected entriesOf(values: Iterable<T>): [CID<T, number, number, 1>, T][] {
    const entries: [CID<T, number, number, 1>, T][] = [];
    for (const value of values) {
      entries.push([this.getCID(value), value]);
    }
    return entries;
  }

  protected getCID(block: T): CID<T, number, number, 1> {
    const bytes = this.blockCodec.encode(block);
    const hash = this.hasher.digest(bytes);
    return CID.create(1, this.blockCodec.code, hash);
  }
}
