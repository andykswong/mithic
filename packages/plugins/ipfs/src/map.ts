import { AutoKeyMap, AutoKeyMapBatch } from '@mithic/collections';
import { AbortOptions, CodedError, ErrorCode, operationError, sha256 } from '@mithic/commons';
import type { IPFS } from 'ipfs-core-types';
import type { create } from 'ipfs-core';
import { BlockCodec, CID, SyncMultihashHasher } from 'multiformats';

/** IPFS concrete type. */
type CIPFS = Awaited<ReturnType<typeof create>>;

/** A distributed {@link AutoKeyMap} based on {@link IPFS} bitswap. */
export class IpfsMap<T = Uint8Array>
  implements AutoKeyMap<CID, T>, AutoKeyMapBatch<CID, T>
{
  protected readonly ipfs: CIPFS;

  public constructor(
    /** {@link IPFS} instance. */
    ipfs: IPFS,
    /** Codec to encode data for storage. */
    protected readonly codec: BlockCodec<number, T>,
    /** Hash function to use for generating CIDs for block data. */
    protected readonly hasher: SyncMultihashHasher<number> = sha256
  ) {
    this.ipfs = ipfs as CIPFS;
  }

  public async get(key: CID, options?: AbortOptions): Promise<T | undefined> {
    try {
      const bytes = await this.ipfs.block.get(key, options);
      return this.codec.decode(bytes);
    } catch (err) {
      if ((err as CodedError)?.code === ErrorCode.NotFound) {
        return;
      }
      throw err;
    }
  }

  public async has(key: CID, options?: AbortOptions): Promise<boolean> {
    return (await this.get(key, options)) !== void 0;
  }

  public put(value: T, options?: AbortOptions): Promise<CID> {
    return this.ipfs.block.put(this.codec.encode(value), { ...options, format: this.codec.code, version: 1 });
  }

  public async delete(cid: CID, options?: AbortOptions): Promise<void> {
    for await (const result of this.ipfs.block.rm(cid, { ...options, force: true })) {
      if (result.error) {
        throw result.error;
      }
    }
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
    for await (const result of this.ipfs.block.rm([...keys], { ...options, force: true })) {
      if (result.error) {
        yield result.error;
      } else {
        yield;
      }
    }
  }

  public async * putMany(
    values: Iterable<T>, options?: AbortOptions
  ): AsyncIterableIterator<[key: CID, error?: Error | undefined]> {
    for (const value of values) {
      const bytes = this.codec.encode(value);
      try {
        yield [await this.ipfs.block.put(bytes, { ...options, format: this.codec.code, version: 1 })];
      } catch (error) {
        const key = CID.create(1, this.codec.code, this.hasher.digest(bytes));
        yield [
          key,
          operationError('Failed to put', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error)
        ];
      }
    }
  }

  public get [Symbol.toStringTag](): string {
    return IpfsMap.name;
  }
}
