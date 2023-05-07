import { AbortOptions, CodedError, ErrorCode, Startable, operationError } from '@mithic/commons';
import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.js';
import { RangeQueryOptions, RangeQueryable } from '../query.js';

/** A map that stores data in IndexedDB. */
export class IndexedDBMap<K, V>
  implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, AsyncIterable<[K, V]>, RangeQueryable<K, V>, Startable {
  private db?: IDBDatabase;

  public constructor(
    /** Name of IndexedDB database to use. */
    private readonly dbName: string,
    /** Name of IndexedDB store to use. */
    private readonly storeName: string,
    /** The key encoder. */
    protected readonly encodeKey: (key: K) => IDBValidKey = (k) => k as IDBValidKey,
    /** The key decoder. */
    protected readonly decodeKey: (key: IDBValidKey) => K = (k) => k as K,
  ) {
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
    const request = (await this.openObjectStore()).get(this.encodeKey(key));
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
    const request = (await this.openObjectStore(true)).put(value, this.encodeKey(key));
    await asPromise(request);
  }

  public async delete(key: K): Promise<void> {
    const request = (await this.openObjectStore(true)).delete(this.encodeKey(key));
    await asPromise(request);
  }

  public async * getMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore();
    for (const key of keys) {
      yield asPromise(store.get(this.encodeKey(key)));
      options?.signal?.throwIfAborted();
    }
  }

  public async * hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore();
    for (const key of keys) {
      yield (await asPromise(store.get(this.encodeKey(key)))) !== void 0;
      options?.signal?.throwIfAborted();
    }
  }

  public async * setMany(entries: Iterable<[K, V]>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore(true);
    for (const [key, value] of entries) {
      try {
        await asPromise(store.put(value, this.encodeKey(key)));
        yield;
      } catch (error) {
        yield operationError('Failed to set value', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
      options?.signal?.throwIfAborted();
    }
  }

  public async * deleteMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<Error | undefined> {
    options?.signal?.throwIfAborted();
    const store = await this.openObjectStore(true);
    for (const key of keys) {
      try {
        await asPromise(store.delete(this.encodeKey(key)));
        yield;
      } catch (error) {
        yield operationError('Failed to delete key', (error as CodedError)?.code ?? ErrorCode.OpFailed, key, error);
      }
      options?.signal?.throwIfAborted();
    }
  }

  public async *entries(options?: RangeQueryOptions<K>): AsyncIterableIterator<[K, V]> {
    const request = (await this.openObjectStore())
      .openCursor(...toCursorOptions(options, this.encodeKey));
    for await (const cursor of cursorAsIterable(request, options?.limit)) {
      options?.signal?.throwIfAborted();
      yield [this.decodeKey(cursor.key), cursor.value];
    }
  }

  public async *keys(options?: RangeQueryOptions<K>): AsyncIterableIterator<K> {
    const request = (await this.openObjectStore())
      .openKeyCursor(...toCursorOptions(options, this.encodeKey));
    for await (const cursor of cursorAsIterable(request, options?.limit)) {
      options?.signal?.throwIfAborted();
      yield this.decodeKey(cursor.key);
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

function toCursorOptions<K>(
  options: RangeQueryOptions<K> = {},
  encodeKey: (key: K) => IDBValidKey
): [IDBKeyRange | null, IDBCursorDirection] {
  const lower = options.gte ?? options.gt;
  const lowerOpen = options.gte === void 0;
  const upper = options.lte ?? options.lt;
  const upperOpen = options.lte === void 0;

  const bound = lower !== void 0 ? upper !== void 0 ?
    IDBKeyRange.bound(encodeKey(lower), encodeKey(upper), lowerOpen, upperOpen) :
    IDBKeyRange.lowerBound(encodeKey(lower), lowerOpen) :
    upper !== void 0 ? IDBKeyRange.upperBound(encodeKey(upper), upperOpen) : null;

  return [bound, options?.reverse ? 'prev' : 'next'];
}
