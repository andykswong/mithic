import { AutoKeyMap, AutoKeyMapBatch } from '@mithic/collections';
import { AbortOptions, CodedError, ErrorCode, MaybePromise, operationError, sha256 } from '@mithic/commons';
import { Blockstore } from 'interface-blockstore';
import { BlockCodec, CID, SyncMultihashHasher } from 'multiformats';

/** A distributed {@link AutoKeyMap} based on {@link Blockstore}. */
export class BlockstoreMap<T = Uint8Array>
  implements AutoKeyMap<CID, T>, AutoKeyMapBatch<CID, T>
{
  public constructor(
    /** {@link Blockstore} instance. */
    protected readonly store: Blockstore,
    /** Codec to encode data for storage. */
    protected readonly codec: BlockCodec<number, T>,
    /** Hash function to use for generating ContentIds for block data. */
    protected readonly hasher: SyncMultihashHasher<number> = sha256
  ) {
  }

  public getKey(value: T): CID {
    return CID.create(1, this.codec.code, this.hasher.digest(this.codec.encode(value)));
  }

  public get(key: CID, options?: AbortOptions): MaybePromise<T | undefined> {
    try {
      return MaybePromise.map(this.store.get(key, options), this.codec.decode);
    } catch (err) {
      mapGetError(err);
    }
  }

  public has(key: CID, options?: AbortOptions): MaybePromise<boolean> {
    return MaybePromise.map(this.get(key, options), isDefined);
  }

  public put(value: T, options?: AbortOptions): MaybePromise<CID> {
    const data = this.codec.encode(value);
    const hash = this.hasher.digest(data);
    const key = CID.createV1(this.codec.code, hash);
    return this.store.put(key, data, options);
  }

  public delete(cid: CID, options?: AbortOptions): MaybePromise<void> {
    return this.store.delete(cid, options);
  }

  public async * getMany(keys: Iterable<CID>, options?: AbortOptions): AsyncIterableIterator<T | undefined> {
    for (const key of keys) {
      yield this.get(key, options);
    }
  }

  public async * hasMany(keys: Iterable<CID>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) {
      yield value !== void 0;
    }
  }

  public async * deleteMany(keys: Iterable<CID>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    for await (const _ of this.store.deleteMany(keys, options)) {
      yield;
    }
  }

  public async * putMany(
    values: Iterable<T>, options?: AbortOptions
  ): AsyncIterableIterator<[key: CID, error?: Error | undefined]> {
    for (const value of values) {
      try {
        yield [await this.put(value, options)];
      } catch (error) {
        const key = this.getKey(value);
        yield [
          key,
          operationError('Failed to put', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error)
        ];
      }
    }
  }

  public get [Symbol.toStringTag](): string {
    return BlockstoreMap.name;
  }
}

function mapGetError(err: unknown): void {
  if ((err as CodedError)?.code === ErrorCode.NotFound) {
    return;
  }
  throw err;
}

function isDefined(value: unknown): boolean {
  return value !== void 0;
}
