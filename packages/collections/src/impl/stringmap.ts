import { DataStringEncoder, JSON_ENCODING } from '@mithic/commons';

/** A map indexed by stringified key. */
export class StringKeyMap<K, V> implements Map<K, V>, Iterable<[K, V]> {
  public constructor(
    /** underlying map. */
    protected readonly map: Map<string, [K, V]> = new Map(),
    /** The key encoder. */
    protected readonly keyEncoder: DataStringEncoder<K> = JSON_ENCODING as DataStringEncoder<K>,
  ) {
  }

  public get size(): number {
    return this.map.size;
  }

  public get(key: K): V | undefined {
    return this.map.get(this.keyEncoder.encode(key))?.[1];
  }

  public set(key: K, value: V): this {
    this.map.set(this.keyEncoder.encode(key), [key, value]);
    return this;
  }

  public clear(): void {
    this.map.clear();
  }

  public delete(key: K): boolean {
    return this.map.delete(this.keyEncoder.encode(key));
  }

  public has(key: K): boolean {
    return this.map.has(this.keyEncoder.encode(key));
  }

  public forEach(callbackfn: (value: V, key: K, self: StringKeyMap<K, V>) => void, thisArg?: unknown): void {
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

  public get[Symbol.toStringTag](): string {
    return StringKeyMap.name;
  }
}
