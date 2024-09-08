import { TextCodec, type Codec } from '@mithic/commons';
import { BaseKeyValueStore } from './base.ts';
import { type KeyValueStore } from '../provider/index.ts';
import { KeyOrder, type KeyResponse, type KeySelector, StoreError, StoreErrorType } from '../types.ts';

/** A keyvalue store that stores data in local/session storage with prefixed keys. */
export class LocalStorageKeyValueStore extends BaseKeyValueStore implements KeyValueStore {
  private readonly storage: Storage;
  private readonly namespace: string;
  private readonly separator: string;
  private readonly codec: Codec<string>;

  public constructor({
    storage = globalThis.localStorage,
    keyPrefix = '',
    keySeparator = ':',
    codec = new TextCodec()
  }: LocalStorageKeyValueStoreOptions = {}) {
    super();
    this.storage = storage;
    this.namespace = keyPrefix ? keyPrefix + keySeparator : keyPrefix;
    this.separator = keySeparator;
    this.codec = codec;
  }

  public get [Symbol.toStringTag](): string {
    return LocalStorageKeyValueStore.name;
  }

  public override open(identifier: string): string {
    return identifier;
  }

  public override close(_bucket: string): void { }

  public override listKeys(bucket: string, selector?: KeySelector): KeyResponse {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; ++i) {
      const key = this.decodeKey(bucket, this.storage.key(i));
      if (key !== null && this.keyInRange(key, selector)) {
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
    const results = [];
    for (const key of keys) {
      const valueString = this.storage.getItem(this.encodeKey(bucket, key));
      results.push(valueString !== null ? this.codec.encode(valueString) : null);
    }
    return results;
  }

  public override exists(bucket: string, key: string): boolean {
    return this.storage.getItem(this.encodeKey(bucket, key)) !== null;
  }

  public override updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): void {
    for (const [key, value] of keyValues) {
      const fullKey = this.encodeKey(bucket, key);
      if (value === null) {
        this.storage.removeItem(fullKey);
      } else {
        const valueStr = this.decodeValue(value);
        if (valueStr === null) {
          throw new StoreError({
            tag: StoreErrorType.Other,
            val: `failed to set non-UTF8 value to storage for bucket: ${bucket}, key: ${key}`
          });
        }
        try {
          this.storage.setItem(fullKey, valueStr);
        } catch (e) {
          throw new StoreError({
            tag: StoreErrorType.Other,
            val: `failed to set value to storage for bucket: ${bucket}, key: ${key}, error: ${e}`
          });
        }
      }
    }
  }

  public override increment(bucket: string, key: string, delta: bigint): bigint {
    const fullKey = this.encodeKey(bucket, key);
    const valueStr = this.storage.getItem(fullKey);
    let value = 0n;
    if (valueStr) {
      try {
        value = BigInt(valueStr);
      } catch {
        throw new StoreError({
          tag: StoreErrorType.Other,
          val: `Cannot convert value to bigint at bucket: ${bucket}, key: ${key}`
        });
      }
    }

    const newValue = value + delta;
    this.storage.setItem(fullKey, `0x${newValue.toString(16)}`);
    return newValue;
  }

  public override compareAndSwap(bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean {
    const fullKey = this.encodeKey(bucket, key);
    const existingValueStr = this.storage.getItem(fullKey);
    const oldValueStr = oldValue ? this.decodeValue(oldValue, 'invalid old value') : null;

    if (oldValueStr !== existingValueStr) {
      return false;
    }

    const newValueStr = newValue ? this.decodeValue(newValue, 'invalid new value') : null;
    if (newValueStr === null) {
      this.storage.removeItem(fullKey);
    } else {
      this.storage.setItem(fullKey, newValueStr);
    }
    return true;
  }

  private encodeKey(bucket: string, key: string): string {
    return this.getKeyNS(bucket) + key;
  }

  private decodeKey(bucket: string, key: string | null): string | null {
    const namespace = this.getKeyNS(bucket);
    if (!key?.startsWith(namespace)) {
      return null;
    }
    return key.substring(namespace.length);
  }

  private getKeyNS(bucket: string) {
    return `${this.namespace}${bucket ? bucket + this.separator : ''}`;
  }

  private decodeValue(value: Uint8Array, throwMsg?: string): string | null {
    try {
      return this.codec.decode(value) ?? null;
    } catch {
      if (throwMsg) {
        throw new StoreError({ tag: StoreErrorType.Other, val: throwMsg });
      }
    }
    return null;
  }
}

/** Options for creating a {@link LocalStorageKeyValueStore}. */
export interface LocalStorageKeyValueStoreOptions {
  /** The underlying storage. */
  readonly storage?: Storage;
  /** Unique prefix for keys. */
  readonly keyPrefix?: string;
  /** Key namespace separator. */
  readonly keySeparator?: string;
  /** Value codec. */
  readonly codec?: Codec<string>;
}
