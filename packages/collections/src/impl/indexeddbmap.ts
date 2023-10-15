import { AbortOptions, CodedError, DisposableCloseable, OperationError, Startable } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { RangeQueryOptions, RangeQueryable } from '../query.js';

/** A map that stores data in IndexedDB. */
export class IndexedDBMap<K extends IDBValidKey, V>
  extends DisposableCloseable
  implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, AsyncIterable<[K, V]>, RangeQueryable<K, V>, Startable, Disposable {
  private db?: IDBDatabase;

  public constructor(
    /** Name of IndexedDB database to use. */
    private readonly dbName: string,
    /** Name of IndexedDB store to use. */
    private readonly storeName: string
  ) {
    super();
  }

  public get started(): boolean {
    return !!this.db;
  }

  public async start(): Promise<void> {
    if (!this.db) {
      await this.openDB();
    }
  }

  public close(): void {
    this.db?.close();
    this.db = void 0;
  }

  public async get(key: K): Promise<V | undefined> {
    const request = (await this.openObjectStore()).get(key);
    const result = await asPromise(request);
    return result;
  }

  public async has(key: K): Promise<boolean> {
    return (await this.get(key)) !== void 0;
  }

  public async clear(): Promise<void> {
    const request = (await this.openObjectStore(true)).clear();
    await asPromise(request);
  }

  public async set(key: K, value: V): Promise<void> {
    const request = (await this.openObjectStore(true)).put(value, key);
    await asPromise(request);
  }

  public async delete(key: K): Promise<void> {
    const request = (await this.openObjectStore(true)).delete(key);
    await asPromise(request);
  }

  public async * getMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore();
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield asPromise(store.get(key));
    }
  }

  public async * hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore();
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      yield (await asPromise(store.get(key))) !== void 0;
    }
  }

  public async * setMany(entries: Iterable<[K, V]>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore(true);
    for (const [key, value] of entries) {
      options?.signal?.throwIfAborted();
      try {
        await asPromise(store.put(value, key));
        yield;
      } catch (cause) {
        yield new OperationError('failed to set value', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key
        });
      }
    }
  }

  public async * deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore(true);
    for (const key of keys) {
      options?.signal?.throwIfAborted();
      try {
        await asPromise(store.delete(key));
        yield;
      } catch (cause) {
        yield new OperationError('failed to delete key', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key
        });
      }
    }
  }

  public async * updateMany(entries: Iterable<[K, V?]>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore(true);
    for (const [key, value] of entries) {
      options?.signal?.throwIfAborted();
      try {
        if (value === void 0) {
          await asPromise(store.delete(key));
        } else {
          await asPromise(store.put(value, key));
        }
        yield;
      } catch (cause) {
        yield new OperationError('failed to update value', {
          cause,
          code: (cause as CodedError)?.code,
          detail: key
        });
      }
    }
  }

  public async *entries(options?: RangeQueryOptions<K>): AsyncIterableIterator<[K, V]> {
    const request = (await this.openObjectStore())
      .openCursor(...toCursorOptions(options));
    for await (const cursor of cursorAsIterable(request, options?.limit)) {
      options?.signal?.throwIfAborted();
      yield [cursor.key as K, cursor.value];
    }
  }

  public async *keys(options?: RangeQueryOptions<K>): AsyncIterableIterator<K> {
    const request = (await this.openObjectStore())
      .openKeyCursor(...toCursorOptions(options));
    for await (const cursor of cursorAsIterable(request, options?.limit)) {
      options?.signal?.throwIfAborted();
      yield cursor.key as K;
    }
  }

  public async *values(options?: RangeQueryOptions<K>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) {
      yield value;
    }
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return IndexedDBMap.name;
  }

  private async openObjectStore(readwrite = false): Promise<IDBObjectStore> {
    return (await this.openDB())
      .transaction(this.storeName, readwrite ? 'readwrite' : 'readonly')
      .objectStore(this.storeName);
  }

  private async openDB(): Promise<IDBDatabase> {
    const request = indexedDB.open(this.dbName);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(this.storeName)) {
        db.createObjectStore(this.storeName);
      }
    };
    return this.db = await asPromise(request);
  }
}

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function* cursorAsIterable<T extends IDBCursor>(
  request: IDBRequest<T | null>, limit = Infinity,
): AsyncIterableIterator<T> {
  for (
    let i = 0, pcursor = asPromise(request), cursor = await pcursor;
    i < limit && cursor;
    ++i, pcursor = asPromise(request), cursor.continue(), cursor = await pcursor
  ) {
    yield cursor;
  }
}

function toCursorOptions<K>(options: RangeQueryOptions<K> = {}): [IDBKeyRange | null, IDBCursorDirection] {
  const lower = options.gte ?? options.gt;
  const lowerOpen = options.gte === void 0;
  const upper = options.lte ?? options.lt;
  const upperOpen = options.lte === void 0;

  const bound = lower !== void 0 ? upper !== void 0 ?
    IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen) :
    IDBKeyRange.lowerBound(lower, lowerOpen) :
    upper !== void 0 ? IDBKeyRange.upperBound(upper, upperOpen) : null;

  return [bound, options?.reverse ? 'prev' : 'next'];
}
