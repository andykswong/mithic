import { TextCodec, type Codec } from '@mithic/commons';
import type { SyncKeyValueProvider, SyncKeyValueStore } from '../service.ts';
import { KeyOrder, type KeyResponse, type KeySelector, StoreError, StoreErrorType } from '../types.ts';
import { BaseKeyValueStore } from './base.ts';

/** Provider of keyvalue stores backed by local/session storage. */
export class LocalStorageKeyValueProvider implements SyncKeyValueProvider {
  private readonly storage: Storage;
  private readonly keyPrefix: string;
  private readonly keySeparator: string;
  private readonly codec: Codec<string>;

  public constructor({
    storage = globalThis.localStorage,
    keyPrefix = '',
    keySeparator = ':',
    codec = new TextCodec()
  }: LocalStorageKeyValueOptions = {}) {
    this.storage = storage;
    this.keyPrefix = keyPrefix;
    this.keySeparator = keySeparator;
    this.codec = codec;
  }

  public open(identifier: string): LocalStorageKeyValueStore {
    return new LocalStorageKeyValueStore({
      name: identifier,
      storage: this.storage,
      keyPrefix: this.keyPrefix,
      keySeparator: this.keySeparator,
      codec: this.codec
    });
  }
}

/** A keyvalue store that stores data in local/session storage with prefixed keys. */
export class LocalStorageKeyValueStore extends BaseKeyValueStore implements SyncKeyValueStore {
  private readonly storage: Storage;
  private readonly codec: Codec<string>;
  private readonly namespace: string;
  public readonly name: string;

  public constructor({ name, storage, keyPrefix, keySeparator, codec }: LocalStorageKeyValueStoreOptions) {
    super();
    this.name = name;
    this.storage = storage;
    this.namespace = `${keyPrefix ? keyPrefix + keySeparator : keyPrefix}${name ? name + keySeparator : ''}`;
    this.codec = codec;
  }

  public get [Symbol.toStringTag](): string {
    return LocalStorageKeyValueStore.name;
  }

  public override listKeys(selector?: KeySelector): KeyResponse {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; ++i) {
      const key = this.decodeKey(this.storage.key(i));
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

  public override exists(key: string): boolean {
    return this.storage.getItem(this.encodeKey(key)) !== null;
  }

  public override getMany(keys: string[]): (Uint8Array | null)[] {
    const results = [];
    for (const key of keys) {
      const valueString = this.storage.getItem(this.encodeKey(key));
      results.push(valueString !== null ? this.codec.encode(valueString) : null);
    }
    return results;
  }

  public override updateMany(keyValues: [key: string, value: Uint8Array | null][]): void {
    for (const [key, value] of keyValues) {
      const fullKey = this.encodeKey(key);
      if (value === null) {
        this.storage.removeItem(fullKey);
      } else {
        const valueStr = this.decodeValue(value);
        if (valueStr === null) {
          throw new StoreError({
            tag: StoreErrorType.Other,
            val: `failed to set non-UTF8 value to storage for bucket: ${this.name}, key: ${key}`
          });
        }
        try {
          this.storage.setItem(fullKey, valueStr);
        } catch (e) {
          throw new StoreError({
            tag: StoreErrorType.Other,
            val: `failed to set value to storage for bucket: ${this.name}, key: ${key}, error: ${e}`
          });
        }
      }
    }
  }

  public override increment(key: string, delta: bigint): bigint {
    const fullKey = this.encodeKey(key);
    const valueStr = this.storage.getItem(fullKey);
    let value = 0n;
    if (valueStr) {
      try {
        value = BigInt(valueStr);
      } catch {
        throw new StoreError({
          tag: StoreErrorType.Other,
          val: `Cannot convert value to bigint at bucket: ${this.name}, key: ${key}`
        });
      }
    }

    const newValue = value + delta;
    this.storage.setItem(fullKey, `0x${newValue.toString(16)}`);
    return newValue;
  }

  public override compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean {
    const fullKey = this.encodeKey(key);
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

  private encodeKey(key: string): string {
    return this.namespace + key;
  }

  private decodeKey(key: string | null): string | null {
    if (!key?.startsWith(this.namespace)) {
      return null;
    }
    return key.substring(this.namespace.length);
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

/** Options for creating a {@link LocalStorageKeyValueProvider}. */
export interface LocalStorageKeyValueOptions {
  /** The underlying storage. */
  readonly storage?: Storage;
  /** Unique prefix for keys. */
  readonly keyPrefix?: string;
  /** Key namespace separator. */
  readonly keySeparator?: string;
  /** Value codec. */
  readonly codec?: Codec<string>;
}

/** Options for creating a {@link LocalStorageKeyValueStore}. */
export interface LocalStorageKeyValueStoreOptions extends Required<LocalStorageKeyValueOptions> {
  /** The bucket name. */
  readonly name: string;
}
