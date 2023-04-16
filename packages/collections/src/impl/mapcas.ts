import { ContentId, LinkMultibaseEncoding, MaybePromise, mapAsync, sha256 } from '@mithic/commons';
import { BlockCodec, CID, SyncMultihashHasher } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import * as raw from 'multiformats/codecs/raw';
import { ContentAddressedStore } from '../cas.js';
import { MaybeAsyncMap } from '../map.js';
import { BaseContentAddressedStore } from './basecas.js';
import { StringKeyMap } from './stringmap.js';

/**
 * An implementation of {@link ContentAddressedStore} that stores values in a {@link MaybeAsyncMap}.
 */
export class ContentAddressedMapStore<T = Uint8Array>
  extends BaseContentAddressedStore<ContentId, T>
  implements ContentAddressedStore<ContentId, T>
{
  public constructor(
    /** The underlying storage. */
    protected readonly map: MaybeAsyncMap<ContentId, T> = new StringKeyMap(new Map(), new LinkMultibaseEncoding(base64)),
    /** Data binary encoding to use. */
    protected readonly blockCodec: BlockCodec<number, T> = raw as unknown as BlockCodec<number, T>,
    /** Hash function to use for generating CIDs for block data. */
    protected readonly hasher: SyncMultihashHasher<number> = sha256
  ) {
    super();
  }

  public put(block: T): MaybePromise<CID<T, number, number, 1>> {
    const cid = this.getCID(block);
    const result = this.map.set(cid, block);
    return mapAsync(result, () => cid);
  }

  /** Deletes the data with given ID. */
  public delete(cid: ContentId): MaybePromise<void> {
    return this.map.delete(cid) as MaybePromise<void>;
  }

  public get(cid: ContentId): MaybePromise<T | undefined> {
    return this.map.get(cid);
  }

  public get [Symbol.toStringTag](): string {
    return ContentAddressedMapStore.name;
  }

  private getCID(block: T): CID<T, number, number, 1> {
    const bytes = this.blockCodec.encode(block);
    const hash = this.hasher.digest(bytes);
    return CID.create(1, this.blockCodec.code, hash);
  }
}
