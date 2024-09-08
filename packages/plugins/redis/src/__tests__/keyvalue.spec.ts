import { afterEach, beforeEach, describe, expect, it, type jest } from '@jest/globals';
import { dispose } from '@mithic/commons';
import { commandOptions, type RedisClientType } from '@redis/client';
import { RedisKeyValueStore } from '../keyvalue.ts';
import { createMockRedisClient, createMockRedisClientMultiCommand } from './mocks.ts';
import { KeyOrder, StoreError, StoreErrorType, type KeySelector } from '@mithic/keyvalue';

const BUCKET = 'bucket';
const BUCKET_KEYS = 'bucket:keys';
const BATCH_SIZE = 3;
const KEY1 = 'key1';
const KEY1_SIGNAL = 'bucket:signal:key1';
const KEY2 = 'key2';
const VALUE1 = new Uint8Array([1]);
const VALUE2 = new Uint8Array([2]);

describe(RedisKeyValueStore.name, () => {
  let store: RedisKeyValueStore;
  let mockRedis: RedisClientType;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    store = new RedisKeyValueStore(mockRedis, BATCH_SIZE);
    await store.start();
  });

  afterEach(async () => {
    await dispose(store);
  });

  it('should be started', () => {
    expect(store.started).toBe(true);
  });

  it('should have the correct string tag', () => {
    expect(`${store}`).toBe(`[object ${RedisKeyValueStore.name}]`);
  });

  describe('dispose', () => {
    it('should close connection', async () => {
      await dispose(store);
      expect(store.started).toBe(false);
    });
  });

  describe('open', () => {
    it('returns given bucket name as key', async () => {
      expect(await store.open(BUCKET)).toBe(BUCKET);
    });

    it('throws if bucket is not hash or none', async () => {
      (mockRedis.type as jest.Mocked<typeof mockRedis['type']>).mockReturnValueOnce(Promise.resolve('string'));
      await expect(() => store.open(BUCKET)).rejects.toThrow(new StoreError({ tag: StoreErrorType.NoSuchStore }));
    });
  });

  describe('exists', () => {
    it('returns true if value exists', async () => {
      (mockRedis.hGet as jest.Mocked<typeof mockRedis['hGet']>).mockReturnValueOnce(Promise.resolve(VALUE1));
      expect(await store.exists(BUCKET, KEY1)).toBe(true);
      expect(mockRedis.hGet).toHaveBeenCalledWith(BUCKET, KEY1);
    });

    it('returns false if value not exist', async () => {
      (mockRedis.hGet as jest.Mocked<typeof mockRedis['hGet']>).mockReturnValueOnce(Promise.resolve());
      expect(await store.exists(BUCKET, KEY1)).toBe(false);
    });
  });

  describe('getMany', () => {
    it('gets values via Redis client', async () => {
      (mockRedis.hmGet as jest.Mocked<typeof mockRedis['hmGet']>).mockReturnValueOnce(Promise.resolve([VALUE1, VALUE2]));
      const results = await store.getMany(BUCKET, [KEY1, KEY2]);
      expect(results).toEqual([VALUE1, VALUE2]);
      expect(mockRedis.hmGet).toHaveBeenCalledWith(commandOptions({ returnBuffers: true }), BUCKET, [KEY1, KEY2]);
    });
  });

  describe('updateMany', () => {
    it('sets or deletes values via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      (mockRedis.multi as jest.Mocked<typeof mockRedis['multi']>).mockReturnValueOnce(multiMock);

      await store.updateMany(BUCKET, [[KEY1, VALUE1], [KEY2, null]]);
      expect(multiMock.hSet).toHaveBeenCalledWith(BUCKET, [[KEY1, Buffer.from(VALUE1)]]);
      expect(multiMock.zAdd).toHaveBeenCalledWith(BUCKET_KEYS, [{ value: KEY1, score: 0 }]);
      expect(multiMock.hDel).toHaveBeenCalledWith(BUCKET, [KEY2]);
      expect(multiMock.zRem).toHaveBeenCalledWith(BUCKET_KEYS, [KEY2]);
      expect(multiMock.exec).toHaveBeenCalled();
    });
  });

  describe('listKeys', () => {
    it.each([
      [{}, undefined, ['-', '+', undefined, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'b' }, undefined, ['[a', '(b', undefined, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'b', order: KeyOrder.Desc }, undefined, ['(b', '[a', true, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'c' }, 'b', ['(b', '(c', undefined, { offset: 0, count: BATCH_SIZE + 1 }]],
      [{ start: 'a', end: 'c', order: KeyOrder.Desc }, 'b', ['(b', '[a', true, { offset: 0, count: BATCH_SIZE + 1 }]],
    ])('returns zRange result from Redis client %#', async (selector: KeySelector, cursor, [start, end, REV, LIMIT]) => {
      (mockRedis.zRange as jest.Mocked<typeof mockRedis['zRange']>).mockReturnValueOnce(Promise.resolve([KEY1, KEY2]));
      const results = await store.listKeys(BUCKET, selector, cursor);
      expect(results).toEqual({ keys: [KEY1, KEY2] });
      expect(mockRedis.zRange).toHaveBeenCalledWith(BUCKET_KEYS, start, end, { BY: 'LEX', REV, LIMIT });
    });

    it('returns cursor if there are more results', async () => {
      const key3 = 'key3', key4 = 'key4';
      (mockRedis.zRange as jest.Mocked<typeof mockRedis['zRange']>).mockReturnValueOnce(Promise.resolve([KEY1, KEY2, key3, key4]));
      const results = await store.listKeys(BUCKET, { start: 'a', end: 'c' });
      expect(results).toEqual({ keys: [KEY1, KEY2, key3], cursor: key3 });
    })
  });

  describe('increment', () => {
    it('calls hIncrBy on given key', async () => {
      const delta = 3n, value = 2n;
      (mockRedis.hIncrBy as jest.Mocked<typeof mockRedis['hIncrBy']>).mockReturnValueOnce(Promise.resolve(Number(value)));
      const results = await store.increment(BUCKET, KEY1, delta);
      expect(results).toEqual(value);
      expect(mockRedis.hIncrBy).toHaveBeenCalledWith(BUCKET, KEY1, Number(delta));
    })
  });

  describe('compareAndSwap', () => {
    it('check-and-set value', async () => {
      const mockIsolatedRedis = createMockRedisClient();
      const multiMock = createMockRedisClientMultiCommand();
      (mockRedis.executeIsolated as jest.Mocked<typeof mockRedis['executeIsolated']>)
        .mockImplementationOnce(async (callback) => callback(mockIsolatedRedis));
      (mockIsolatedRedis.multi as jest.Mocked<typeof mockRedis['multi']>).mockReturnValueOnce(multiMock);
      (mockIsolatedRedis.hGet as jest.Mocked<typeof mockRedis['hGet']>).mockReturnValueOnce(Promise.resolve(VALUE1));

      expect(await store.compareAndSwap(BUCKET, KEY1, VALUE1, VALUE2)).toBe(true);
      expect(mockIsolatedRedis.watch).toHaveBeenCalledWith(KEY1_SIGNAL);
      expect(mockIsolatedRedis.hGet).toHaveBeenCalledWith(commandOptions({ returnBuffers: true }), BUCKET, KEY1);
      expect(multiMock.set).toHaveBeenCalledWith(KEY1_SIGNAL, '');
      expect(multiMock.hSet).toHaveBeenCalledWith(BUCKET, KEY1, Buffer.from(VALUE2));
      expect(multiMock.exec).toHaveBeenCalled();
    });
  });
});
