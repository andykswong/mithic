import { encode } from 'cbor-x/encode';
import { arrayCompare, type Encoder } from '@mithic/commons';
import { type KeyValueStore } from '../provider/index.ts';
import { KeyOrder, type KeyResponse, type KeySelector, StoreError, StoreErrorType } from '../types.ts';
import { BaseKeyValueStore } from './base.ts';

/**
 * Transient in-memory keyvalue store.
 * Buckets in this store will be automatically deleted when unused, via reference counting.
 */
export class InMemoryKeyValueStore extends BaseKeyValueStore implements KeyValueStore {
  private readonly buckets = new Map<string, Map<string, Uint8Array | bigint>>();
  private readonly bucketRefs = new Map<string, number>();

  public constructor(
    /** Encoder for bigint type. */
    private readonly intEncoder: Encoder<bigint> = {
      encode: (input) => encode(input),
    },
  ) {
    super();
  }

  public get [Symbol.toStringTag](): string {
    return InMemoryKeyValueStore.name;
  }

  public override open(bucket: string): string {
    if (!this.buckets.has(bucket)) {
      this.buckets.set(bucket, new Map());
    }
    this.bucketRefs.set(bucket, (this.bucketRefs.get(bucket) || 0) + 1);
    return bucket;
  }

  public override close(bucket: string): void {
    const refCount = (this.bucketRefs.get(bucket) || 0) - 1;
    if (refCount <= 0) {
      this.buckets.delete(bucket);
      this.bucketRefs.delete(bucket);
    } else {
      this.bucketRefs.set(bucket, refCount);
    }
  }

  public override listKeys(bucket: string, selector?: KeySelector): KeyResponse {
    const map = this.getBucket(bucket);
    const keys = [];
    for (const key of map.keys()) {
      if (this.keyInRange(key, selector)) {
        keys.push(key);
      }
    }
    if (selector?.order) {
      const order = selector.order === KeyOrder.Desc ? -1 : 1;
      keys.sort((a, b) => order * (a < b ? -1 : a === b ? 0 : 1));
    }
    return { keys };
  }

  public override getMany(bucket: string, keys: string[]): (Uint8Array | null)[] {
    const map = this.getBucket(bucket);
    const results = [];
    for (const key of keys) {
      results.push(this.getValue(map, key));
    }
    return results;
  }

  public override updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): void {
    const map = this.getBucket(bucket);
    for (const [key, value] of keyValues) {
      if (value) {
        map.set(key, new Uint8Array(value));
      } else {
        map.delete(key);
      }
    }
  }

  public override increment(bucket: string, key: string, delta: bigint): bigint {
    const map = this.getBucket(bucket);
    const existingValue = map.get(key);
    if (existingValue !== undefined && typeof existingValue !== 'bigint') {
      throw new StoreError({ tag: StoreErrorType.Other, val: `expect bigint, bucket: ${bucket}, key: ${key}` });
    }
    const newValue = (existingValue ?? 0n) + delta;
    map.set(key, newValue);
    return newValue;
  }

  public override compareAndSwap(bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean {
    const map = this.getBucket(bucket);
    const existingValue = this.getValue(map, key);

    if ((!oldValue && existingValue) ||
      (oldValue && (!existingValue || arrayCompare(oldValue, existingValue) !== 0))
    ) {
      return false;
    }

    if (!newValue) {
      map.delete(key);
    } else {
      map.set(key, newValue)
    }
    return true;
  }

  private getBucket(bucket: string) {
    const map = this.buckets.get(bucket);
    if (!map) {
      throw new StoreError({ tag: StoreErrorType.NoSuchStore });
    }
    return map;
  }

  private getValue(bucket: Map<string, bigint | Uint8Array>, key: string): Uint8Array | null {
    const value = bucket.get(key) ?? null;
    return typeof value === 'bigint' ? this.intEncoder.encode(value) : value;
  }
}
