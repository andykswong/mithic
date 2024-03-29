import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.ts';
import { KeyValueIterable } from '../range.ts';
import { SyncMapBatchAdapter } from './batchmap.ts';

/**
 * A map that stores data in local storage with prefixed keys.
 * Note that this does not preserve insertion order.
 */
export class LocalStorageMap<K extends string, V extends string>
  extends SyncMapBatchAdapter<K, V>
  implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, Map<K, V>, Iterable<[K, V]>, KeyValueIterable<K, V>
{
  public constructor(
    /** Unique prefix for keys. */
    protected readonly prefix = '',
    /** The underlying storage. */
    protected readonly storage: Storage = window.localStorage,
  ) {
    super();
  }

  /**
   * Returns the size of this map.
   * Note that this is a heavy operation that loops through
   * the storage to count the number of keys with matching prefix.
   */
  public get size(): number {
    let count = 0;
    for (const _ of this.keys()) {
      ++count;
    }
    return count;
  }

  public get(key: K): V | undefined {
    return this.getValue(this.encodeKey(key));
  }

  public has(key: K): boolean {
    return this.storage.getItem(this.encodeKey(key)) !== null;
  }

  public set(key: K, value: V): this {
    this.storage.setItem(this.encodeKey(key), value);
    return this;
  }

  public delete(key: K): boolean {
    const keyString = this.encodeKey(key);
    const exist = this.storage.getItem(keyString) !== null;
    this.storage.removeItem(keyString);
    return exist;
  }

  public clear(): void {
    for (let i = this.storage.length - 1; i >= 0; --i) {
      const key = this.storage.key(i);
      if (key?.startsWith(this.prefix)) {
        this.storage.removeItem(key);
      }
    }
  }

  public forEach(callbackfn: (value: V, key: K, map: LocalStorageMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  public * keys(): IterableIterator<K> {
    for (let i = this.storage.length - 1; i >= 0; --i) {
      const key = this.decodeKey(this.storage.key(i));
      if (key !== void 0) {
        yield key;
      }
    }
  }

  public * values(): IterableIterator<V> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== void 0) {
        yield value;
      }
    }
  }

  public * entries(): IterableIterator<[K, V]> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== void 0) {
        yield [key, value];
      }
    }
  }

  public [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return LocalStorageMap.name;
  }

  private encodeKey(key: K): string {
    return this.prefix + key;
  }

  private decodeKey(key: string | null): K | undefined {
    if (!key?.startsWith(this.prefix)) {
      return;
    }
    return key.substring(this.prefix.length) as K;
  }

  private getValue(keyString: string | null): V | undefined {
    const value = keyString && this.storage.getItem(keyString);
    if (value === null) {
      return;
    }
    return value as V;
  }
}
