import { indexOf } from './id.js';

/** Generational index map backend by a Map. */
export class GenerationalIdMap<V, I extends number = number>
  implements Map<I, V>, Iterable<[I, V]>
{
  private readonly map: Map<number, [I, V]> = new Map();

  public get size(): number {
    return this.map.size;
  }

  public clear(): void {
    this.map.clear();
  }

  public delete(id: I): boolean {
    const entry = this.map.get(indexOf(id));
    if (entry && entry[0] === id) {
      this.map.delete(indexOf(id));
      return true;
    }
    return false;
  }

  public entries(): IterableIterator<[I, V]> {
    return this.map.values();
  }

  public forEach(callback: (value: V, id: I, self: GenerationalIdMap<V, I>) => void, thisArg?: unknown): void {
    this.map.forEach((entry) => {
      callback.call(thisArg, entry[1], entry[0], this);
    });
  }

  public get(id: I): V | undefined {
    const entry = this.map.get(indexOf(id));
    if (entry && entry[0] === id) {
      return entry[1];
    }
    return undefined;
  }

  public has(id: I): boolean {
    const entry = this.map.get(indexOf(id));
    return !!entry && entry[0] === id;
  }

  public * keys(): IterableIterator<I> {
    for (const entry of this.map.values()) {
      yield entry[0];
    }
  }

  public set(id: I, value: V): this {
    this.map.set(indexOf(id), [id, value]);
    return this;
  }

  public * values(): IterableIterator<V> {
    for (const entry of this.map.values()) {
      yield entry[1];
    }
  }

  public [Symbol.iterator](): IterableIterator<[I, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return GenerationalIdMap.name;
  }
}
