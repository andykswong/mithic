import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { SyncMapBatchAdapter } from './batchmap.js';

/** A map indexed by hashed/encoded key. */
export class HashMap<K, V>
  extends SyncMapBatchAdapter<K, V>
  implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, Map<K, V>, Iterable<[K, V]> {
  public constructor(
    /** underlying map. */
    protected readonly map: Map<string | number, [K, V]> = new Map(),
    /** The key hasher. */
    protected readonly hash: (key: K) => string | number = JSON.stringify
  ) {
    super();
  }

  public get size(): number {
    return this.map.size;
  }

  public get(key: K): V | undefined {
    return this.map.get(this.hash(key))?.[1];
  }

  public set(key: K, value: V): this {
    this.map.set(this.hash(key), [key, value]);
    return this;
  }

  public clear(): void {
    this.map.clear();
  }

  public delete(key: K): boolean {
    return this.map.delete(this.hash(key));
  }

  public has(key: K): boolean {
    return this.map.has(this.hash(key));
  }

  public forEach(callbackfn: (value: V, key: K, self: HashMap<K, V>) => void, thisArg?: unknown): void {
    this.map.forEach(([key, value]) => callbackfn(value, key, this), thisArg);
  }

  public entries(): IterableIterator<[K, V]> {
    return this.map.values();
  }

  public * keys(): IterableIterator<K> {
    for (const [key] of this.map.values()) {
      yield key;
    }
  }

  public * values(): IterableIterator<V> {
    for (const [, value] of this.map.values()) {
      yield value;
    }
  }

  public [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return HashMap.name;
  }
}
