import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { type Kv, openKv } from '@deno/kv';
import { dispose } from '@mithic/commons';
import { KeyOrder } from '@mithic/keyvalue';
import { DenoKeyValueProvider, DenoKeyValueStore } from './index.ts';

const BUCKET = 'bucket';
const KEY1 = 'a'
const KEY2 = 'b';
const KEY3 = 'c3';
const VALUE1 = new Uint8Array([1]);
const VALUE2 = new Uint8Array([2]);
const VALUE3 = new Uint8Array([3]);
const CONSISTENCY = 'eventual' as const;
const BATCH_SIZE = 3;
const EXPIRE_IN = 10;

describe('DenoKeyValueProvider', () => {
  let kv: Kv;
  let provider: DenoKeyValueProvider;

  beforeEach(async () => {
    kv = await openKv();
    provider = new DenoKeyValueProvider({ kv, consistency: CONSISTENCY, expireIn: EXPIRE_IN, batchSize: BATCH_SIZE });
  });

  afterEach(() => {
    dispose(provider);
  });

  describe('open', () => {
    it('should return a DenoKeyValueStore', () => {
      const store = provider.open(BUCKET);
      assert.ok(store instanceof DenoKeyValueStore);
      assert.strictEqual(store.name, BUCKET);
      assert.strictEqual(store['batchSize'], BATCH_SIZE);
      assert.strictEqual(store['consistency'], CONSISTENCY);
      assert.strictEqual(store['expireIn'], EXPIRE_IN);
      assert.strictEqual(store['encoder'], provider['options'].encoder);
    });

    it('throws if Kv is closed', () => {
      dispose(provider);
      assert.throws(() => provider.open(BUCKET), /StoreError: Kv is closed/);
    })
  });

  describe('dispose', () => {
    it('should close underlying Kv', async () => {
      const closeSpy = mock.method(kv, 'close');
      dispose(provider);
      assert.strictEqual(closeSpy.mock.callCount(), 1);
    });
  });
});

describe('DenoKeyValueStore', () => {
  let kv: Kv;
  let provider: DenoKeyValueProvider;
  let store: DenoKeyValueStore;

  beforeEach(async () => {
    kv = await openKv();
    provider = new DenoKeyValueProvider({ kv, consistency: CONSISTENCY, expireIn: EXPIRE_IN, batchSize: BATCH_SIZE });
    store = provider.open(BUCKET);
  });

  afterEach(() => {
    dispose(provider);
  });

  it('should have the correct string tag', () => {
    assert.strictEqual(`${store}`, `[object ${DenoKeyValueStore.name}]`);
  });

  describe('exists', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
    });

    it('should return true for existing entry', async () => {
      assert.strictEqual(await store.exists(KEY1), true);
    });

    it('should return false for missing entry', async () => {
      assert.strictEqual(await store.exists(KEY2), false);
    });
  });

  describe('getMany', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.set([BUCKET, KEY2], VALUE2);
    });

    it('should get all entries', async () => {
      const getManySpy = mock.method(kv, 'getMany');
      assert.deepStrictEqual(await store.getMany([KEY1, KEY2]), [VALUE1, VALUE2]);
      assert.strictEqual(getManySpy.mock.callCount(), 1);
      assert.deepStrictEqual(getManySpy.mock.calls[0].arguments, [[[BUCKET, KEY1], [BUCKET, KEY2]], { consistency: CONSISTENCY }]);
    });

    it('should return null for missing entries', async () => {
      assert.deepStrictEqual(await store.getMany([KEY1, 'null', KEY2]), [VALUE1, null, VALUE2]);
    });
  });

  describe('updateMany', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.set([BUCKET, KEY2], VALUE2);
    });

    it('should set or delete entries', async () => {
      const newValue1 = new Uint8Array([4]);
      await store.updateMany([[KEY1, newValue1], [KEY2, null], [KEY3, VALUE3]]);
      assert.deepStrictEqual(await store.getMany([KEY1, KEY2, KEY3]), [newValue1, null, VALUE3]);
    });
  });

  describe('listKeys', () => {
    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.set([BUCKET, KEY2], VALUE2);
      await kv.set([BUCKET, KEY3], VALUE3);
    });

    for (const [selector, keys] of [
      [{}, [KEY1, KEY2, KEY3]],
      [{ start: KEY1, end: 'key4', order: KeyOrder.Desc }, [KEY3, KEY2, KEY1]],
      [{ start: KEY2 }, [KEY2, KEY3]],
      [{ end: KEY3 }, [KEY1, KEY2]],
      [{ start: 'key4' }, []],
    ] as const) {
      it('should return keys within specified selector', async () => {
        const results = await store.listKeys(selector);
        assert.deepStrictEqual(results.keys, keys);
      });
    }

    it('should support pagination', async () => {
      const key4 = 'key4', key5 = 'key5';
      const value4 = new Uint8Array([4]), value5 = new Uint8Array([5]);
      await kv.set([BUCKET, key4], value4);
      await kv.set([BUCKET, key5], value5);

      const results1 = await store.listKeys({ order: KeyOrder.Desc });
      assert.deepStrictEqual(results1.keys, [key5, key4, KEY3]);

      const results2 = await store.listKeys({ order: KeyOrder.Desc }, results1.cursor);
      assert.deepStrictEqual(results2.keys, [KEY2, KEY1]);

      const results3 = await store.listKeys({ order: KeyOrder.Desc }, results2.cursor);
      assert.deepStrictEqual(results3, { keys: [], cursor: undefined });
    })
  });

  describe('increment', () => {
    const key = 'counter';
    const value = 0xefn;

    beforeEach(async () => {
      await kv.set([BUCKET, KEY1], VALUE1);
      await kv.atomic().sum([BUCKET, key], value).commit();
    });

    it('should increment stored number', async () => {
      assert.strictEqual(await store.increment(key, 123n), 0x16an);
    });

    it('throw if trying to update a non int key', async () => {
      await assert.rejects(() => store.increment(KEY1, 1n), /StoreError: expect bigint/);
    });
  });

  describe('compareAndSwap', () => {
    const key = 'counter';
    const value = new Uint8Array([0xef, 0, 0, 0, 0, 0, 0, 0]);

    beforeEach(async () => {
      await kv.set([BUCKET, key], value);
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
      assert.strictEqual(
        await store.compareAndSwap(key, new Uint8Array([1, 3, 3, 7]), new Uint8Array([0, 0, 1, 0])),
        false
      );
    });
  });
});
