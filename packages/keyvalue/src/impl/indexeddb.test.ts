import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { encode } from 'cbor-x/encode';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dispose } from '@mithic/commons';
import { KeyOrder, StoreError, StoreErrorType } from '../types.ts';
import { IDBKeyValueProvider, IDBKeyValueStore } from './index.ts';

const DB_NAME = 'test-db';
const BUCKET = 'test-store';

describe('IDBKeyValueProvider', () => {
  let db: IDBDatabase;
  let provider: IDBKeyValueProvider;

  beforeEach(async () => {
    db = await createIDB(DB_NAME, BUCKET)
    provider = new IDBKeyValueProvider(db, 3, 'strict');
  });

  describe('open', () => {
    it('should return an IDBKeyValueStore', () => {
      const store = provider.open(BUCKET);
      assert.ok(store instanceof IDBKeyValueStore);
      assert.strictEqual(store.name, BUCKET);
      assert.strictEqual(store['batchSize'], provider['batchSize']);
      assert.strictEqual(store['durability'], provider['durability']);
      assert.strictEqual(store['encoder'], provider['encoder']);
    });

    it('should throw for invalid store name', () => {
      assert.throws(() => provider.open('unknown'), new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });
});

describe('IDBKeyValueStore', () => {
  let db: IDBDatabase;
  let provider: IDBKeyValueProvider;
  let store: IDBKeyValueStore;

  beforeEach(async () => {
    db = await createIDB(DB_NAME, BUCKET)
    provider = new IDBKeyValueProvider(db, 3);
    store = provider.open(BUCKET);
  });

  afterEach(() => {
    dispose(store);
  });

  it('should have correct string tag', () => {
    assert.strictEqual(store.toString(), `[object ${IDBKeyValueStore.name}]`);
  });

  describe('getMany', () => {
    const key1 = '123', key2 = '4';
    const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2]]);
    });

    it('should get data from store', async () => {
      assert.deepStrictEqual(await store.getMany([key1, 'unknown', key2]), [value1, null, value2]);
    });
  });

  describe('exists', () => {
    const key = '123', value = new Uint8Array([4, 5, 6]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should return true if key exists in local storage', async () => {
      assert.strictEqual(await store.exists(key), true);
    });

    it('should return false for non-existent key', async () => {
      assert.strictEqual(await store.exists('1'), false);
    });
  });

  describe('updateMany', () => {
    const key1 = '123', key2 = '4', key3 = '1337';
    const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]), value3 = new Uint8Array([7, 8, 9]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2]]);
    });

    it('should set or deleta data in local storage', async () => {
      await store.updateMany([[key3, value3], [key1, null]]);
      assert.deepStrictEqual(await store.getMany([key1, key2, key3]), [null, value2, value3]);
    });
  });

  describe('increment', () => {
    const key = 'counter';
    const value = 0xefn;

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should increment stored number', async () => {
      assert.strictEqual(await store.increment(key, 123n), 0x16an);
      assert.deepStrictEqual(await store.getMany([key]), [encode(0x16an)]);
    });

    it('throw if trying to increment a non-bigint value', async () => {
      await set([[key, new Uint8Array([1, 2, 3])]]);
      await assert.rejects(
        () => store.increment(key, 1n),
        new StoreError({ tag: StoreErrorType.Other, val: `expect bigint, bucket: ${BUCKET}, key: ${key}` })
      );
    });
  });

  describe('compareAndSwap', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should replace stored value if matches old value', async () => {
      const newValue = new Uint8Array([0x6a, 0x01, 0, 0]);
      assert.strictEqual(await store.compareAndSwap(key, value, newValue), true);
      assert.deepStrictEqual(await store.getMany([key]), [newValue]);
    });

    it('should set value if old value is undefined', async () => {
      const key = 'counter2';
      assert.strictEqual(await store.compareAndSwap(key, undefined, value), true);
      assert.deepStrictEqual(await store.getMany([key]), [value]);
    });

    it('should delete stored value if matches old value and new value is undefined', async () => {
      assert.strictEqual(await store.compareAndSwap(key, value, undefined), true);
      assert.strictEqual(await store.exists(key), false);
    });

    it('should return false if stored value does not match old value', async () => {
      assert.strictEqual(await store.compareAndSwap(key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0])), false);
      assert.deepStrictEqual(await store.getMany([key]), [value]);
    });
  });

  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';
    const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2], [key3, value3]]);
    });

    it('should return all keys by default', async () => {
      assert.deepStrictEqual(await store.listKeys(), { cursor: undefined, keys: [key1, key2, key3] });
    });

    for (const [selector, keys] of [
      [{}, [key1, key2, key3]],
      [{ order: KeyOrder.Asc }, [key1, key2, key3]],
      [{ order: KeyOrder.Desc }, [key3, key2, key1]],
      [{ start: key2, order: KeyOrder.Asc }, [key2, key3]],
      [{ end: key2, order: KeyOrder.Asc }, [key1]],
      [{ end: key3, order: KeyOrder.Desc }, [key2, key1]],
      [{ start: key2, end: key3 }, [key2]],
      [{ start: key2, end: key2, order: KeyOrder.Asc }, []],
    ] as const) {
      it('should return filtered keys in correct order', async () => {
        assert.deepStrictEqual(await store.listKeys(selector), { cursor: undefined, keys });
      });
    }

    describe('cursor', () => {
      const key4 = '4', key5 = '5', value4 = new Uint8Array([4]), value5 = new Uint8Array([5]);

      beforeEach(async () => {
        await set([[key4, value4], [key5, value5]]);
      });

      it('should support pagination', async () => {
        const query1 = await store.listKeys();
        assert.deepStrictEqual(query1, { keys: [key1, key2, key3], cursor: key3 });

        const query2 = await store.listKeys({}, key3);
        assert.deepStrictEqual(query2, { cursor: undefined, keys: [key4, key5] });
      });

      it('should support pagination in reverse', async () => {
        const query1 = await store.listKeys({ end: key5, order: KeyOrder.Desc });
        assert.deepStrictEqual(query1, { keys: [key4, key3, key2], cursor: key2 });

        const query2 = await store.listKeys({ end: key5, order: KeyOrder.Desc }, key2);
        assert.deepStrictEqual(query2, { cursor: undefined, keys: [key1] });
      });
    });
  });

  async function set(keyValues: [string, unknown][]) {
    const tx = db.transaction(BUCKET, 'readwrite'), store = tx.objectStore(BUCKET);
    for (const [key, value] of keyValues) {
      store.put(value, key);
    }
    await txPromise(tx);
  }
});

function createIDB(dbName: string, bucket: string): Promise<IDBDatabase> {
  const indexedDB = new IDBFactory();
  const request = indexedDB.open(dbName);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(bucket)) {
      db.createObjectStore(bucket);
    }
  };
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function txPromise(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onabort = tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}
