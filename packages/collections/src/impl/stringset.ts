import { DataStringEncoder, JSON_ENCODING } from '@mithic/commons';

/** A set that uses stringified values as unique keys. */
export class StringSet<T> implements Set<T>, Iterable<T> {
  public constructor(
    /** underlying map. */
    protected readonly map: Map<string, T> = new Map(),
    /** The key encoder. */
    protected readonly keyEncoder: DataStringEncoder<T> = JSON_ENCODING as DataStringEncoder<T>,
  ) {
  }

  public get size(): number {
    return this.map.size;
  }

  public add(value: T): this {
    this.map.set(this.keyEncoder.encode(value), value);
    return this;
  }

  public clear(): void {
    this.map.clear();
  }

  public delete(value: T): boolean {
    return this.map.delete(this.keyEncoder.encode(value));
  }

  public forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    this.map.forEach((value) => callbackfn(value, value, this), thisArg);
  }

  public has(value: T): boolean {
    return this.map.has(this.keyEncoder.encode(value));
  }

  public * entries(): IterableIterator<[T, T]> {
    for (const value of this.map.values()) {
      yield [value, value];
    }
  }

  public keys(): IterableIterator<T> {
    return this.map.values();
  }

  public values(): IterableIterator<T> {
    return this.keys();
  }

  public [Symbol.iterator](): IterableIterator<T> {
    return this.keys();
  }

  public get[Symbol.toStringTag](): string {
    return StringSet.name;
  }
}
