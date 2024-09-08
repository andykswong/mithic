import { encode } from 'cbor-x/encode';
import type { Kv, KvConsistencyLevel, KvKey, KvListSelector } from '@deno/kv';
import { arrayCompare, type Encoder } from '@mithic/commons';
import {
  KeyOrder, StoreError, StoreErrorType, type KeyResponse, type KeySelector, type KeyValueStore
} from '@mithic/keyvalue';

/** Deno {@link Kv} implementation of {@link KeyValueStore}. */
export class DenoKeyValueStore implements KeyValueStore, Disposable {
  private readonly kv: Kv;
  private readonly batchSize: number;
  private readonly consistency: KvConsistencyLevel;
  private readonly expireIn?: number;
  private readonly encoder: Encoder<unknown>;
  private closed = false;

  public constructor({
    kv,
    batchSize = 100,
    consistency = 'strong',
    expireIn,
    encoder = CborEncoder,
  }: DenoKeyValueStoreOptions) {
    this.kv = kv;
    this.batchSize = batchSize;
    this.consistency = consistency;
    this.expireIn = expireIn;
    this.encoder = encoder;
  }

  public get [Symbol.toStringTag](): string {
    return DenoKeyValueStore.name;
  }

  public [Symbol.dispose](): void {
    if (!this.closed) {
      this.kv.close();
      this.closed = true;
    }
  }

  public open(identifier: string): string {
    return identifier;
  }

  public close(_bucket: string): void {
    // noop
  }

  public async exists(bucket: string, key: string): Promise<boolean> {
    const result = await this.kv.get(getKvKey(bucket, key), { consistency: this.consistency });
    return result.value !== null;
  }

  public async listKeys(bucket: string, selector?: KeySelector, cursor?: string): Promise<KeyResponse> {
    const results = this.kv.list(toKvListSelector(bucket, selector), {
      batchSize: this.batchSize,
      consistency: this.consistency,
      cursor,
      limit: this.batchSize,
      reverse: selector?.order === KeyOrder.Desc,
    });
    const keys: string[] = [];
    for await (const entry of results) {
      if (entry.key.length > 1 && entry.key[0] === bucket) {
        keys.push(`${entry.key[1]}`);
      }
    }
    return { keys, cursor: keys.length ? results.cursor : undefined };
  }

  public async getMany(bucket: string, keys: string[]): Promise<(Uint8Array | null)[]> {
    const response = await this.kv.getMany(keys.map(getKvKey.bind(null, bucket)), { consistency: this.consistency });
    const results: (Uint8Array | null)[] = [];
    for (const result of response) {
      results.push(result.versionstamp !== null ? this.encoder.encode(result.value) : null);
    }
    return results;
  }

  public async updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): Promise<void> {
    let tx = this.kv.atomic();
    for (const [key, value] of keyValues) {
      if (value) {
        tx = tx.set(getKvKey(bucket, key), value, { expireIn: this.expireIn });
      } else {
        tx = tx.delete(getKvKey(bucket, key));
      }
    }
    const result = await tx.commit();
    if (!result.ok) {
      throw new StoreError({ tag: StoreErrorType.Other, val: 'failed to commit' });
    }
  }

  public async increment(bucket: string, key: string, delta: bigint): Promise<bigint> {
    const kvkey = getKvKey(bucket, key);
    let result: bigint | undefined;
    for (let i = 0; i < 3; ++i) {
      const existing = await this.kv.get(kvkey, { consistency: 'strong' });
      const value = (existing.value as KvU64).value ?? existing.value ?? 0n;
      if (!['bigint', 'string', 'number'].includes(typeof value)) {
        throw new StoreError({ tag: StoreErrorType.Other, val: `expect bigint, bucket: ${bucket}, key: ${key}` });
      }

      const commit = await this.kv.atomic()
        .check(existing)
        .sum(kvkey, delta)
        .commit();

      if (commit.ok) {
        result = BigInt(value) + delta;
        break;
      }
    }
    if (result === undefined) { throw new StoreError({ tag: StoreErrorType.Timeout }); }
    return result;
  }

  public async compareAndSwap(
    bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array
  ): Promise<boolean> {
    const kvkey = getKvKey(bucket, key);
    const existing = await this.kv.get(kvkey, { consistency: 'strong' });
    const existingValue = existing.versionstamp !== null ? this.encoder.encode(existing.value) : null;

    if (
      (!existingValue && oldValue) ||
      (existingValue && (!oldValue || arrayCompare(existingValue, oldValue) !== 0))
    ) {
      return false;
    }

    let tx = this.kv.atomic().check(existing);
    if (newValue) {
      tx = tx.set(kvkey, newValue, { expireIn: this.expireIn });
    } else {
      tx = tx.delete(kvkey);
    }
    return (await tx.commit()).ok;
  }
}

/** Options for creating a {@link DenoKeyValueStore}. */
export interface DenoKeyValueStoreOptions {
  /** Backing Kv. */
  readonly kv: Kv,
  /** Batch size for listKeys operation. Defaults to 100. */
  readonly batchSize?: number,
  /** Consistency level for get operations. Defaults to 'strong'. */
  readonly consistency?: KvConsistencyLevel,
  /** If set, all new keys will expire with given TTL in milliseconds. */
  readonly expireIn?: number;
  /** Encoding to use for reading non-binary data from Kv as Uint8Array. */
  readonly encoder?: Encoder<unknown>;
}

/** Returns data encoded as CBOR, unless it's already binary data. */
const CborEncoder = {
  encode(input: unknown): Uint8Array {
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    return encode(input);
  },
} satisfies Encoder<unknown>;

function toKvListSelector(bucket: string, selector?: KeySelector): KvListSelector {
  const lower = selector?.start !== undefined ? [bucket, selector.start] : undefined;
  const upper = selector?.end !== undefined ? [bucket, selector.end] : undefined;
  return lower ? upper ? { start: lower, end: upper } : { prefix: [bucket], start: lower } :
    upper ? { prefix: [bucket], end: upper } : { prefix: [bucket] };
}

function getKvKey(bucket: string, key: string): KvKey {
  return bucket ? [bucket, key] : [key];
}

/** Deno internal type for u64 integers. */
interface KvU64 {
  readonly value: bigint;
}
