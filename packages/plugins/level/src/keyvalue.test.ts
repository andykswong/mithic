import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryLevel } from 'memory-level';
import { dispose } from '@mithic/commons';
import { KeyOrder, StoreError, StoreErrorType, type KeySelector } from '@mithic/keyvalue';
import { LevelKeyValueStore } from './index.ts';

describe('LevelKeyValueStore', () => {
  const bucket = 'test-store';
  let level: MemoryLevel<string, Uint8Array>;
  let store: LevelKeyValueStore;

  beforeEach(async () => {
    level = new MemoryLevel({ storeEncoding: 'view' });
    store = new LevelKeyValueStore({ level, batchSize: 3 });
    await store.open(bucket);
  });

  afterEach(async () => {
    await dispose(store);
  });

  it('should have started', () => {
    assert.strictEqual(store.started, true);
  });

  it('should have the correct string tag', () => {
    assert.strictEqual(`${store}`, `[object ${LevelKeyValueStore.name}]`);
  });

  describe('open', () => {
    it('should return identifier as is', async () => {
      assert.strictEqual(await store.open(bucket), bucket);
    });
  });

  describe('close', () => {
    it('should delete sublevel handle', async () => {
      store.close(bucket);
      assert.strictEqual(store['sublevels'].has(bucket), false);
    });
  });

  describe('getMany', () => {
    const key1 = '123', key2 = '4';
    const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2]]);
    });

    it('should get data from store', async () => {
      assert.deepStrictEqual(await get([key1, 'unknown', key2]), [value1, null, value2]);
    });

    it('throws if trying to get a non-opened store', async () => {
      await assert.rejects(() => store.getMany('unknown', ['key']), new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('exists', () => {
    const key = '123', value = new Uint8Array([4, 5, 6]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should return true if key exists in local storage', async () => {
      assert.strictEqual(await store.exists(bucket, key), true);
    });

    it('should return false for non-existent key', async () => {
      assert.strictEqual(await store.exists(bucket, '1'), false);
    });

    it('throw if trying to check a non-opened store', async () => {
      await assert.rejects(
        async () => { await store.exists('unknown', 'key'); },
        new StoreError({ tag: StoreErrorType.NoSuchStore })
      );
    });
  });

  describe('updateMany', () => {
    const key1 = '123', key2 = '4', key3 = '1337';
    const value1 = new Uint8Array([1, 2, 3]), value2 = new Uint8Array([4, 5, 6]), value3 = new Uint8Array([7, 8, 9]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2]]);
    });

    it('should set or deleta data in local storage', async () => {
      await store.updateMany(bucket, [[key3, value3], [key1, null]]);
      assert.deepStrictEqual(await get([key1, key2, key3]), [null, value2, value3]);
    });

    it('throw if trying to update a non-opened store', async () => {
      await assert.rejects(
        () => store.updateMany('unknown', [['123', new Uint8Array([1])]]),
        new StoreError({ tag: StoreErrorType.NoSuchStore })
      );
    });
  });

  describe('increment', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should increment stored number', async () => {
      assert.strictEqual(await store.increment(bucket, key, 123n), 0x16an);
      assert.deepStrictEqual(await get([key]), [new Uint8Array([0x6a, 0x01, 0, 0, 0, 0, 0, 0])]);
    });

    it('throw if trying to update a non-opened store', async () => {
      await assert.rejects(
        async () => { await store.increment('unknown', 'key', 1n); },
        new StoreError({ tag: StoreErrorType.NoSuchStore })
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
      assert.strictEqual(await store.compareAndSwap(bucket, key, value, newValue), true);
      assert.deepStrictEqual(await get([key]), [newValue]);
    });

    it('should set value if old value is undefined', async () => {
      const key = 'counter2';
      assert.strictEqual(await store.compareAndSwap(bucket, key, undefined, value), true);
      assert.deepStrictEqual(await get([key]), [value]);
    });

    it('should delete stored value if matches old value and new value is undefined', async () => {
      assert.strictEqual(await store.compareAndSwap(bucket, key, value, undefined), true);
      assert.strictEqual(await store.exists(bucket, key), false);
    });

    it('should return false if stored value does not match old value', async () => {
      assert.strictEqual(await store.compareAndSwap(bucket, key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0])), false);
      assert.deepStrictEqual(await get([key]), [value]);
    });

    it('throw if trying to update a non-opened store', async () => {
      await assert.rejects(
        async () => { await store.compareAndSwap('unknown', 'key', new Uint8Array([1]), undefined); },
        new StoreError({ tag: StoreErrorType.NoSuchStore })
      );
    });
  });

  describe('listKeys', () => {
    const key1 = '1', key2 = '2', key3 = '3';
    const value1 = new Uint8Array([1]), value2 = new Uint8Array([2]), value3 = new Uint8Array([3]);

    beforeEach(async () => {
      await set([[key1, value1], [key2, value2], [key3, value3]]);
    });

    it('should return all keys by default', async () => {
      assert.deepStrictEqual(await store.listKeys(bucket), { cursor: undefined, keys: [key1, key2, key3] });
    });

    for (const [selector, keys, cursor = undefined] of [
      [{} as KeySelector, [key1, key2, key3]],
      [{ order: KeyOrder.Asc }, [key1, key2, key3]],
      [{ order: KeyOrder.Desc }, [key3, key2, key1]],
      [{ start: key2, order: KeyOrder.Asc }, [key2, key3]],
      [{ end: key2, order: KeyOrder.Asc }, [key1]],
      [{ end: key3, order: KeyOrder.Desc }, [key2, key1]],
      [{ start: key2, end: key3 }, [key2]],
      [{ start: key2, end: key2, order: KeyOrder.Asc }, []],
    ] as const) {
      it('should return filtered keys in correct order', async () => {
        assert.deepStrictEqual(await store.listKeys(bucket, selector), { keys, cursor });
      });
    }

    describe('cursor', () => {
      const key4 = '4', key5 = '5', value4 = new Uint8Array([4]), value5 = new Uint8Array([5]);

      beforeEach(async () => {
        await set([[key4, value4], [key5, value5]]);
      });

      it('should support pagination', async () => {
        const query1 = await store.listKeys(bucket);
        assert.deepStrictEqual(query1, { keys: [key1, key2, key3], cursor: key3 });

        const query2 = await store.listKeys(bucket, {}, key3);
        assert.deepStrictEqual(query2, { cursor: undefined, keys: [key4, key5] });
      });

      it('should support pagination in reverse', async () => {
        const query1 = await store.listKeys(bucket, { end: key5, order: KeyOrder.Desc });
        assert.deepStrictEqual(query1, { keys: [key4, key3, key2], cursor: key2 });

        const query2 = await store.listKeys(bucket, { end: key5, order: KeyOrder.Desc }, key2);
        assert.deepStrictEqual(query2, { cursor: undefined, keys: [key1] });
      });

    });
  });

  async function get(keys: string[]): Promise<(Uint8Array | null)[]> {
    return (await level.sublevel<string, Uint8Array>(bucket, { keyEncoding: 'utf8', valueEncoding: 'view' })
      .getMany(keys)).map(v => v ?? null);
  }

  async function set(keyValues: [string, Uint8Array][]) {
    const tx = level
      .sublevel<string, Uint8Array>(bucket, { keyEncoding: 'utf8', valueEncoding: 'view' })
      .batch();
    for (const [key, value] of keyValues) {
      tx.put(key, value);
    }
    await tx.write();
  }
});
