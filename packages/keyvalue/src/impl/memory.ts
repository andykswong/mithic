import { encode } from 'cbor-x/encode';
import { arrayCompare, type Encoder } from '@mithic/commons';
import type { SyncKeyValueProvider, SyncKeyValueStore } from '../service.ts';
import { KeyOrder, type KeyResponse, type KeySelector, StoreError, StoreErrorType } from '../types.ts';
import { BaseKeyValueStore } from './base.ts';

/**
 * Provider of transient in-memory keyvalue stores.
 * This provider holds weak ref to stores which means they will be automatically deleted when unused.
 */
export class InMemoryKeyValueProvider implements SyncKeyValueProvider {
  private readonly buckets = new Map<string, WeakRef<InMemoryKeyValueStore>>();
  private readonly intEncoder: Encoder<bigint>;

  public constructor(
    /** Encoder for bigint type. */
    intEncoder: Encoder<bigint> = {
      encode: (input) => encode(input),
    },
  ) {
    this.intEncoder = intEncoder;
  }

  public open(bucket: string): InMemoryKeyValueStore {
    let store = this.buckets.get(bucket)?.deref();
    if (!store) {
      store = new InMemoryKeyValueStore(bucket, this.intEncoder);
      this.buckets.set(bucket, new WeakRef(store));
    }
    return store;
  }
}

/** Transient in-memory keyvalue store. */
export class InMemoryKeyValueStore extends BaseKeyValueStore implements SyncKeyValueStore {
  private readonly data = new Map<string, Uint8Array | bigint>;
  private readonly intEncoder: Encoder<bigint>;
  /** The bucket name */
  public readonly name: string;

  public constructor(
    name: string,
    /** Encoder for bigint type. */
    intEncoder: Encoder<bigint> = {
      encode: (input) => encode(input),
    },
  ) {
    super();
    this.name = name;
    this.intEncoder = intEncoder;
  }

  public get [Symbol.toStringTag](): string {
    return InMemoryKeyValueStore.name;
  }

  public override exists(key: string): boolean {
    return super.exists(key) as boolean;
  }

  public override listKeys(selector?: KeySelector): KeyResponse {
    const keys = [];
    for (const key of this.data.keys()) {
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

  public override getMany(keys: string[]): (Uint8Array | null)[] {
    const results = [];
    for (const key of keys) {
      results.push(this.getValue(key));
    }
    return results;
  }

  public override updateMany(keyValues: [key: string, value: Uint8Array | null][]): void {
    for (const [key, value] of keyValues) {
      if (value) {
        this.data.set(key, new Uint8Array(value));
      } else {
        this.data.delete(key);
      }
    }
  }

  public override increment(key: string, delta: bigint): bigint {
    const existingValue = this.data.get(key);
    if (existingValue !== undefined && typeof existingValue !== 'bigint') {
      throw new StoreError({ tag: StoreErrorType.Other, val: `expect bigint, bucket: ${this.name}, key: ${key}` });
    }
    const newValue = (existingValue ?? 0n) + delta;
    this.data.set(key, newValue);
    return newValue;
  }

  public override compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean {
    const existingValue = this.getValue(key);

    if ((!oldValue && existingValue) ||
      (oldValue && (!existingValue || arrayCompare(oldValue, existingValue) !== 0))
    ) {
      return false;
    }

    if (!newValue) {
      this.data.delete(key);
    } else {
      this.data.set(key, newValue);
    }
    return true;
  }

  private getValue(key: string): Uint8Array | null {
    const value = this.data.get(key) ?? null;
    return typeof value === 'bigint' ? this.intEncoder.encode(value) : value;
  }
}
