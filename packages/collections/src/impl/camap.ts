import {
  AbortOptions, ContentId, CIDMultibaseEncoding, MaybePromise, maybeAsync, sha256
} from '@mithic/commons';
import { BlockCodec, CID, SyncMultihashHasher } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import * as raw from 'multiformats/codecs/raw';
import { AutoKeyMap, AutoKeyMapBatch, MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { StringKeyMap } from './stringmap.js';

/**
 * A content-addressable map store that persists values in a backing {@link MaybeAsyncMap}.
 */
export class ContentAddressedMapStore<T = Uint8Array>
  implements AutoKeyMap<ContentId, T>, AutoKeyMapBatch<ContentId, T>
{
  public constructor(
    /** The underlying storage. */
    protected readonly map: MaybeAsyncMap<ContentId, T> & Partial<MaybeAsyncMapBatch<ContentId, T>>
      = new StringKeyMap(new Map(), new CIDMultibaseEncoding(base64)),
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

  public deleteMany(keys: Iterable<ContentId>, options?: AbortOptions): MaybePromise<void> {
    return this.map.deleteMany ? this.map.deleteMany(keys, options) : this.deleteEach(keys, options);
  }

  public async * putMany(values: Iterable<T>, options?: AbortOptions): AsyncIterableIterator<ContentId> {
    if (this.map.setMany) {
      const entries = this.entriesOf(values);
      await this.map.setMany(entries, options);
      for (const [key] of entries) {
        yield key;
      }
    } else {
      for (const value of values) {
        yield this.put(value, options);
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

  public get [Symbol.toStringTag](): string {
    return ContentAddressedMapStore.name;
  }

  protected deleteEach = maybeAsync(function* (this: ContentAddressedMapStore<T>, keys: Iterable<ContentId>, options?: AbortOptions) {
    for (const key of keys) {
      yield this.delete(key, options);
    }
  }, this);

  protected * entriesOf(values: Iterable<T>): IterableIterator<[CID<T, number, number, 1>, T]> {
    for (const value of values) {
      yield [this.getCID(value), value];
    }
  }

  protected getCID(block: T): CID<T, number, number, 1> {
    const bytes = this.blockCodec.encode(block);
    const hash = this.hasher.digest(bytes);
    return CID.create(1, this.blockCodec.code, hash);
  }
}
