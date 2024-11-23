import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryLevel } from 'memory-level';
import { dispose } from '@mithic/commons';
import { KeyOrder, type KeySelector } from '@mithic/keyvalue';
import { LevelKeyValueProvider, LevelKeyValueStore } from './index.ts';

const BUCKET = 'test-store';

describe('LevelKeyValueProvider', () => {
  let level: MemoryLevel<string, Uint8Array>;
  let provider: LevelKeyValueProvider;

  beforeEach(() => {
    level = new MemoryLevel({ storeEncoding: 'view' });
    provider = new LevelKeyValueProvider({ level, batchSize: 3 });
  });

  afterEach(async () => {
    await dispose(provider);
  });

  describe('start', () => {
    it('should start the underlying Level DB', async () => {
      await provider.start();
      assert.strictEqual(provider.started, true);
    });
  });

  describe('open', () => {
    it('should return a LevelKeyValueStore', async () => {
      const store = await provider.open(BUCKET);
      assert.strictEqual(provider.started, true);
      assert.ok(store instanceof LevelKeyValueStore);
    });
  });
});

describe('LevelKeyValueStore', () => {
  let level: MemoryLevel<string, Uint8Array>;
  let provider: LevelKeyValueProvider;
  let store: LevelKeyValueStore;

  beforeEach(async () => {
    level = new MemoryLevel({ storeEncoding: 'view' });
    provider = new LevelKeyValueProvider({ level, batchSize: 3 });
    store = await provider.open(BUCKET);
  });

  afterEach(async () => {
    await dispose(provider);
  });

  it('should have the correct string tag', () => {
    assert.strictEqual(`${store}`, `[object ${LevelKeyValueStore.name}]`);
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
      assert.deepStrictEqual(await get([key1, key2, key3]), [null, value2, value3]);
    });
  });

  describe('increment', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await set([[key, value]]);
    });

    it('should increment stored number', async () => {
      assert.strictEqual(await store.increment(key, 123n), 0x16an);
      assert.deepStrictEqual(await get([key]), [new Uint8Array([0x6a, 0x01, 0, 0, 0, 0, 0, 0])]);
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
      assert.deepStrictEqual(await get([key]), [newValue]);
    });

    it('should set value if old value is undefined', async () => {
      const key = 'counter2';
      assert.strictEqual(await store.compareAndSwap(key, undefined, value), true);
      assert.deepStrictEqual(await get([key]), [value]);
    });

    it('should delete stored value if matches old value and new value is undefined', async () => {
      assert.strictEqual(await store.compareAndSwap(key, value, undefined), true);
      assert.ok(await get([key]));
    });

    it('should return false if stored value does not match old value', async () => {
      assert.strictEqual(await store.compareAndSwap(key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0])), false);
      assert.deepStrictEqual(await get([key]), [value]);
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
        assert.deepStrictEqual(await store.listKeys(selector), { keys, cursor });
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

  async function get(keys: string[]): Promise<(Uint8Array | null)[]> {
    return (await level.sublevel<string, Uint8Array>(BUCKET, { keyEncoding: 'utf8', valueEncoding: 'view' })
      .getMany(keys)).map(v => v ?? null);
  }

  async function set(keyValues: [string, Uint8Array][]) {
    const tx = level
      .sublevel<string, Uint8Array>(BUCKET, { keyEncoding: 'utf8', valueEncoding: 'view' })
      .batch();
    for (const [key, value] of keyValues) {
      tx.put(key, value);
    }
    await tx.write();
  }
});
