import { AutoKeyMap, AutoKeyMapBatch } from '@mithic/collections';
import { AbortOptions, CodedError, ContentId, MaybePromise, OperationError } from '@mithic/commons';
import { Blockstore } from 'interface-blockstore';
import { BlockCodec, CID, MultihashHasher } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';

/** A distributed {@link AutoKeyMap} based on {@link Blockstore}. */
export class BlockstoreMap<T = Uint8Array>
  implements AutoKeyMap<ContentId, T>, AutoKeyMapBatch<ContentId, T>
{
  public constructor(
    /** {@link Blockstore} instance. */
    protected readonly store: Blockstore,
    /** Codec to encode data for storage. */
    protected readonly codec: BlockCodec<number, T>,
    /** Hash function to use for generating ContentIds for block data. */
    protected readonly hasher: MultihashHasher<number> = sha256
  ) {
  }

  public getKey(value: T): MaybePromise<CID> {
    return MaybePromise.map(
      this.hasher.digest(this.codec.encode(value)),
      (hash) => CID.create(1, this.codec.code, hash)
    );
  }

  public get(key: ContentId, options?: AbortOptions): MaybePromise<T | undefined> {
    try {
      return MaybePromise.map(this.store.get(this.asCID(key), options), this.codec.decode);
    } catch (err) {
      mapGetError(err);
    }
  }

  public has(key: ContentId, options?: AbortOptions): MaybePromise<boolean> {
    return MaybePromise.map(this.get(this.asCID(key), options), isDefined);
  }

  public put(value: T, options?: AbortOptions): MaybePromise<CID> {
    const data = this.codec.encode(value);
    return MaybePromise.map(
      this.hasher.digest(data),
      (hash) => this.store.put(CID.create(1, this.codec.code, hash), data, options)
    );
  }

  public delete(key: ContentId, options?: AbortOptions): MaybePromise<void> {
    return this.store.delete(this.asCID(key), options);
  }

  public async * getMany(keys: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<T | undefined> {
    for (const key of keys) {
      yield this.get(key, options);
    }
  }

  public async * hasMany(keys: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) {
      yield value !== void 0;
    }
  }

  public async * deleteMany(keys: Iterable<ContentId>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    for await (const _ of this.store.deleteMany([...keys].map(this.asCID), options)) {
      yield;
    }
  }

  public async * putMany(
    values: Iterable<T>, options?: AbortOptions
  ): AsyncIterableIterator<[key: CID, error?: Error | undefined]> {
    for (const value of values) {
      try {
        yield [await this.put(value, options)];
      } catch (cause) {
        const key = await this.getKey(value);
        yield [
          key,
          new OperationError('failed to put', { cause, code: (cause as CodedError)?.code, detail: key })
        ];
      }
    }
  }

  public get [Symbol.toStringTag](): string {
    return BlockstoreMap.name;
  }

  protected asCID = (key: ContentId): CID => {
    return CID.create(1, key.code, { ...key.multihash, size: key.multihash.digest.byteLength });
  };
}

function mapGetError(err: unknown): void {
  if ((err as CodedError)?.code === 'ERR_NOT_FOUND') {
    return;
  }
  throw err;
}

function isDefined(value: unknown): boolean {
  return value !== void 0;
}
