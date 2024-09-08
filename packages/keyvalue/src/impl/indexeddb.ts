import { arrayCompare, type Encoder } from '@mithic/commons';
import { encode } from 'cbor-x/encode';
import { type KeyValueStore } from '../provider/index.ts';
import { type KeySelector, type KeyResponse, StoreError, StoreErrorType, KeyOrder } from '../types.ts';
import { BaseKeyValueStore } from './base.ts';

/** A keyvalue store that persists data in IndexedDB. */
export class IDBKeyValueStore extends BaseKeyValueStore implements KeyValueStore, Disposable {
  public constructor(
    /** The IndexedDB database to use. */
    private readonly db: IDBDatabase,
    /** The batch size for listKeys operation. */
    private readonly batchSize: number = 100,
    /** Transaction durability mode. */
    private readonly durability?: IDBTransactionDurability,
    /** Encoder for values. */
    private readonly encoder: Encoder<unknown> = CborEncoder,
  ) {
    super();
  }

  public get [Symbol.toStringTag](): string {
    return IDBKeyValueStore.name;
  }

  public [Symbol.dispose](): void {
    this.db.close();
  }

  public override open(storeName: string): string {
    this.assertStoreExist(storeName);
    return storeName;
  }

  public override close(_bucket: string): void {
    // no-op
  }

  public override async listKeys(bucket: string, selector?: KeySelector, cursor?: string): Promise<KeyResponse> {
    const query = getIDBQuery(selector, cursor);
    if (!query) { return { keys: [] }; }

    const tx = this.transaction(bucket, true);
    const request = tx.objectStore(bucket).openKeyCursor(...query);
    const keys: string[] = [];
    let i = 0, lastKey, newCursor;

    for await (const cursor of cursorAsIterable(request, this.batchSize + 1)) {
      if (i++ === this.batchSize) {
        newCursor = lastKey;
        break;
      }
      lastKey = `${cursor.key}`;
      keys.push(lastKey);
    }
    return { keys, cursor: newCursor };
  }

  public override async getMany(bucket: string, keys: string[]): Promise<(Uint8Array | null)[]> {
    const tx = this.transaction(bucket, true);
    const store = tx.objectStore(bucket);
    const results: Promise<Uint8Array | undefined>[] = [];
    for (const key of keys) {
      results.push(requestPromise(store.get(key)));
    }
    return (await Promise.all(results)).map((value) => (value ?? null) && this.encoder.encode(value));
  }

  public override async updateMany(
    bucket: string, keyValues: [key: string, value: Uint8Array | null][]
  ): Promise<void> {
    const tx = this.transaction(bucket, true);
    const store = tx.objectStore(bucket);
    for (const [key, value] of keyValues) {
      if (value === null) {
        store.delete(key);
      } else {
        store.put(value, key);
      }
    }
    await txPromise(tx);
  }

  public override async increment(bucket: string, key: string, delta: bigint): Promise<bigint> {
    const tx = this.transaction(bucket, true);
    const store = tx.objectStore(bucket);

    const existingValue = await requestPromise(store.get(key));
    if (existingValue !== undefined && existingValue !== null && typeof existingValue !== 'bigint') {
      tx.commit();
      throw new StoreError({ tag: StoreErrorType.Other, val: `expect bigint, bucket: ${bucket}, key: ${key}` });
    }

    const newValue = (existingValue ?? 0n) + delta;
    store.put(newValue, key);
    await txPromise(tx);
    return newValue;
  }

  public override async compareAndSwap(
    bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array
  ): Promise<boolean> {
    const tx = this.transaction(bucket, true);
    const store = tx.objectStore(bucket);

    const existingValue = await requestPromise(store.get(key));
    if ((!oldValue && existingValue) ||
      (oldValue && (!(existingValue instanceof Uint8Array) || arrayCompare(oldValue, existingValue) !== 0))
    ) {
      tx.commit();
      return false;
    }

    if (!newValue) {
      store.delete(key);
    } else {
      store.put(newValue, key);
    }
    await txPromise(tx);

    return true;
  }

  private transaction(storeName: string, readwrite = false): IDBTransaction {
    this.assertStoreExist(storeName);
    return this.db
      .transaction(storeName, readwrite ? 'readwrite' : 'readonly', { durability: this.durability });
  }

  private assertStoreExist(storeName: string): void {
    if (!this.db.objectStoreNames.contains(storeName)) {
      throw new StoreError({ tag: StoreErrorType.NoSuchStore });
    }
  }
}

function txPromise(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onabort = tx.onerror = () => reject(new StoreError({
      tag: StoreErrorType.Other,
      val: `${tx.error || 'unknown error'}`,
    }));
    tx.oncomplete = () => resolve();
  });
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () => reject(new StoreError({
      tag: StoreErrorType.Other,
      val: `${request.error || 'unknown error'}`,
    }));
    request.onsuccess = () => resolve(request.result);
  });
}

async function* cursorAsIterable<T extends IDBCursor>(
  request: IDBRequest<T | null>, limit = Infinity,
): AsyncIterableIterator<T> {
  for (
    let i = 0, pcursor = requestPromise(request), cursor = await pcursor;
    i < limit && cursor;
    ++i, pcursor = requestPromise(request), cursor.continue(), cursor = await pcursor
  ) {
    yield cursor;
  }
}

function getIDBQuery(selector?: KeySelector, cursor?: string): [IDBKeyRange | null, IDBCursorDirection] | null {
  const reverse = selector?.order === KeyOrder.Desc;
  let lower = selector?.start;
  let upper = selector?.end;
  let lowerOpen = false;

  if (cursor !== undefined) {
    if (reverse) {
      upper = upper === undefined || cursor < upper ? cursor : upper;
    } else {
      lower = lower === undefined || cursor > lower ? cursor : lower;
      if (lower === cursor) {
        lowerOpen = true;
      }
    }
  }

  let bound = null;
  if (lower !== undefined) {
    if (upper === undefined) {
      bound = IDBKeyRange.lowerBound(lower, lowerOpen);
    } else if (lower >= upper) {
      return null; // invalid bound
    } else {
      bound = IDBKeyRange.bound(lower, upper, lowerOpen, true);
    }
  } else if (upper !== undefined) {
    bound = IDBKeyRange.upperBound(upper, true);
  }

  return [bound, reverse ? 'prev' : 'next'];
}

/** Returns data encoded as CBOR, unless it's already binary data. */
const CborEncoder = {
  encode(input: unknown): Uint8Array {
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    return encode(input);
  },
} satisfies Encoder<unknown>;
