import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dispose } from '@mithic/commons';
import { commandOptions, type RedisClientType } from '@redis/client';
import { KeyOrder, StoreError, StoreErrorType } from '@mithic/keyvalue';
import { assertCallCount, assertCalledWith, mocked } from './test/assert.ts';
import { createMockRedisClient, createMockRedisClientMultiCommand } from './test/mocks.js';
import { RedisKeyValueProvider, RedisKeyValueStore } from './index.ts';

const BUCKET = 'bucket';
const BUCKET_KEYS = 'bucket:keys';
const BATCH_SIZE = 3;
const KEY1 = 'key1';
const KEY1_SIGNAL = 'bucket:signal:key1';
const KEY2 = 'key2';
const VALUE1 = new Uint8Array([1]);
const VALUE2 = new Uint8Array([2]);

describe('RedisKeyValueProvider', () => {
  let mockRedis: RedisClientType;
  let provider: RedisKeyValueProvider;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    provider = new RedisKeyValueProvider(mockRedis, BATCH_SIZE);
  });

  afterEach(async () => {
    await dispose(provider);
  });

  describe('start', () => {
    it('should start the Redis client', async () => {
      await provider.start();
      assert.strictEqual(provider.started, true);
    });
  });

  describe('dispose', () => {
    it('should close connection', async () => {
      await provider.start();
      await dispose(provider);
      assert.strictEqual(provider.started, false);
    });
  });

  describe('open', () => {
    it('returns given bucket name as key', async () => {
      const store = await provider.open(BUCKET);
      assert.ok(store instanceof RedisKeyValueStore);
      assert.strictEqual(store.name, BUCKET);
      assert.strictEqual(store['client'], mockRedis);
      assert.strictEqual(store['batchSize'], BATCH_SIZE);
      assert.strictEqual(store['rangeKey'], provider['rangeKey']);
      assert.strictEqual(store['signalKey'], provider['signalKey']);
    });

    it('throws if bucket is not hash or none', async () => {
      mocked(mockRedis.type).mock.mockImplementationOnce(() => Promise.resolve('string'));
      await assert.rejects(() => provider.open(BUCKET), new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });
});

describe('RedisKeyValueStore', () => {
  let mockRedis: RedisClientType;
  let provider: RedisKeyValueProvider;
  let store: RedisKeyValueStore;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    provider = new RedisKeyValueProvider(mockRedis, BATCH_SIZE);
    store = await provider.open(BUCKET);
  });

  afterEach(async () => {
    await dispose(provider);
  });

  it('should have the correct string tag', () => {
    assert.strictEqual(`${store}`, `[object ${RedisKeyValueStore.name}]`);
  });

  describe('exists', () => {
    it('returns true if value exists', async () => {
      mocked(mockRedis.hGet).mock.mockImplementationOnce((() => Promise.resolve(VALUE1)) as RedisClientType['hGet']);
      assert.strictEqual(await store.exists(KEY1), true);
      assertCalledWith(mockRedis.hGet, 0, BUCKET, KEY1);
    });

    it('returns false if value not exist', async () => {
      mocked(mockRedis.hGet).mock.mockImplementationOnce((() => Promise.resolve()) as RedisClientType['hGet']);
      assert.strictEqual(await store.exists(KEY1), false);
    });
  });

  describe('getMany', () => {
    it('gets values via Redis client', async () => {
      mocked(mockRedis.hmGet).mock.mockImplementationOnce((() => Promise.resolve([VALUE1, VALUE2])) as RedisClientType['hmGet']);
      const results = await store.getMany([KEY1, KEY2]);
      assert.deepStrictEqual(results, [VALUE1, VALUE2]);
      assertCalledWith(mockRedis.hmGet, 0, commandOptions({ returnBuffers: true }), BUCKET, [KEY1, KEY2]);
    });
  });

  describe('updateMany', () => {
    it('sets or deletes values via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      mocked(mockRedis.multi).mock.mockImplementationOnce(() => multiMock);

      await store.updateMany([[KEY1, VALUE1], [KEY2, null]]);
      assertCalledWith(multiMock.hSet, 0, BUCKET, [[KEY1, Buffer.from(VALUE1)]]);
      assertCalledWith(multiMock.zAdd, 0, BUCKET_KEYS, [{ value: KEY1, score: 0 }]);
      assertCalledWith(multiMock.hDel, 0, BUCKET, [KEY2]);
      assertCalledWith(multiMock.zRem, 0, BUCKET_KEYS, [KEY2]);
      assertCallCount(multiMock.exec, 1);
    });
  });

  describe('listKeys', () => {
    for (const [selector, cursor, [start, end, REV, LIMIT]] of [
      [{}, undefined, ['-', '+', undefined, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'b' }, undefined, ['[a', '(b', undefined, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'b', order: KeyOrder.Desc }, undefined, ['(b', '[a', true, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'c' }, 'b', ['(b', '(c', undefined, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'c', order: KeyOrder.Desc }, 'b', ['(b', '[a', true, { offset: 0, count: BATCH_SIZE + 1 }]],
    ] as const) {
      it('returns zRange result from Redis client', async () => {
        mocked(mockRedis.zRange).mock.mockImplementationOnce(() => Promise.resolve([KEY1, KEY2]));
        const results = await store.listKeys(selector, cursor);
        assert.deepStrictEqual(results, { cursor: undefined, keys: [KEY1, KEY2] });
        assertCalledWith(mockRedis.zRange, 0, BUCKET_KEYS, start, end, { BY: 'LEX', REV, LIMIT });
      });
    }

    it('returns cursor if there are more results', async () => {
      const key3 = 'key3', key4 = 'key4';
      mocked(mockRedis.zRange).mock.mockImplementationOnce(() => Promise.resolve([KEY1, KEY2, key3, key4]));
      const results = await store.listKeys({ start: 'a', end: 'c' });
      assert.deepStrictEqual(results, { keys: [KEY1, KEY2, key3], cursor: key3 });
    })
  });

  describe('increment', () => {
    it('calls hIncrBy on given key', async () => {
      const delta = 3n, value = 2n;
      mocked(mockRedis.hIncrBy).mock.mockImplementationOnce(() => Promise.resolve(Number(value)));
      const results = await store.increment(KEY1, delta);
      assert.deepStrictEqual(results, value);
      assertCalledWith(mockRedis.hIncrBy, 0, BUCKET, KEY1, Number(delta));
    })
  });

  describe('compareAndSwap', () => {
    it('check-and-set value', async () => {
      const mockIsolatedRedis = createMockRedisClient();
      const multiMock = createMockRedisClientMultiCommand();
      mocked(mockRedis.executeIsolated).mock.mockImplementationOnce(async (callback) => callback(mockIsolatedRedis));
      mocked(mockIsolatedRedis.multi).mock.mockImplementationOnce(() => multiMock);
      mocked(mockIsolatedRedis.hGet).mock.mockImplementationOnce((() => Promise.resolve(VALUE1)) as RedisClientType['hGet']);

      assert.strictEqual(await store.compareAndSwap(KEY1, VALUE1, VALUE2), true);
      assertCalledWith(mockIsolatedRedis.watch, 0, KEY1_SIGNAL);
      assertCalledWith(mockIsolatedRedis.hGet, 0, commandOptions({ returnBuffers: true }), BUCKET, KEY1);
      assertCalledWith(multiMock.set, 0, KEY1_SIGNAL, '');
      assertCalledWith(multiMock.hSet, 0, BUCKET, KEY1, Buffer.from(VALUE2));
      assertCallCount(multiMock.exec, 1);
    });
  });
});
