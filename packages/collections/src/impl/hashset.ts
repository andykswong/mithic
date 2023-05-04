/** A set that uses hashed/encoded values as unique keys. */
export class HashSet<T> implements Set<T>, Iterable<T> {
  public constructor(
    /** underlying map. */
    protected readonly map: Map<string | number, T> = new Map(),
    /** The key hasher. */
    protected readonly hash: (key: T) => string | number = JSON.stringify
  ) {
  }

  public get size(): number {
    return this.map.size;
  }

  public add(value: T): this {
    this.map.set(this.hash(value), value);
    return this;
  }

  public clear(): void {
    this.map.clear();
  }

  public delete(value: T): boolean {
    return this.map.delete(this.hash(value));
  }

  public forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    this.map.forEach((value) => callbackfn(value, value, this), thisArg);
  }

  public has(value: T): boolean {
    return this.map.has(this.hash(value));
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
    return HashSet.name;
  }
}
