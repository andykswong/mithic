import { SyncMapBatchAdapter } from '../impl/batchmap.ts';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.ts';
import { KeyValueIterable } from '../range.ts';
import { indexOf } from './id.ts';

/** Sparse set based map with generational index as key. */
export class SparseSetMap<V, I extends number = number>
  extends SyncMapBatchAdapter<I, V>
  implements MaybeAsyncMap<I, V>, MaybeAsyncMapBatch<I, V>, Map<I, V>, Iterable<[I, V]>, KeyValueIterable<I, V>
{
  private readonly sparse: number[] = [];
  private readonly ids: I[] = [];
  private readonly dense: V[] = [];

  public get size(): number {
    return this.dense.length;
  }

  public clear(): void {
    this.sparse.length = 0;
    this.ids.length = 0;
    this.dense.length = 0;
  }

  public delete(id: I): boolean {
    if (this.has(id)) {
      const index = indexOf(id);
      const denseIndex = this.sparse[index];

      this.sparse[indexOf(this.ids[this.size - 1])] = denseIndex;
      this.ids[denseIndex] = this.ids[this.size - 1];
      this.dense[denseIndex] = this.dense[this.size - 1];

      this.sparse[index] = -1;
      this.ids.pop();
      this.dense.pop();

      return true;
    }

    return false;
  }

  public * entries(): IterableIterator<[I, V]> {
    for (let i = 0; i < this.ids.length; ++i) {
      yield [this.ids[i], this.dense[i]];
    }
  }

  public forEach(callback: (value: V, id: I, self: SparseSetMap<V, I>) => void, thisArg?: unknown): void {
    this.ids.forEach((id, i) => {
      callback.call(thisArg, this.dense[i], id, this);
    });
  }

  public get(id: I): V | undefined {
    return this.has(id) ? this.dense[this.sparse[indexOf(id)]] : undefined;
  }

  public has(id: I): boolean {
    return (this.ids[this.sparse[indexOf(id)]] === id);
  }

  public * keys(): IterableIterator<I> {
    for (let i = 0; i < this.ids.length; ++i) {
      yield this.ids[i];
    }
  }

  public set(id: I, value: V): this {
    const denseIndex = this.sparse[indexOf(id)];
    if (!isNaN(denseIndex) && denseIndex >= 0) {
      this.ids[denseIndex] = id;
      this.dense[denseIndex] = value;
    } else {
      this.sparse[indexOf(id)] = this.ids.length;
      this.ids.push(id);
      this.dense.push(value);
    }
    return this;
  }

  public * values(): IterableIterator<V> {
    for (let i = 0; i < this.ids.length; ++i) {
      yield this.dense[i];
    }
  }

  public [Symbol.iterator](): IterableIterator<[I, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return SparseSetMap.name;
  }
}
