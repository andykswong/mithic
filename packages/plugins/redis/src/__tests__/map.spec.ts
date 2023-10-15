import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { RedisClientType, commandOptions } from '@redis/client';
import { createMockRedisClient, createMockRedisClientMultiCommand } from '../__tests__/mocks.js';
import { RedisMap } from '../map.js';
import { RangeQueryOptions } from '@mithic/collections';
import { ErrorCode, operationError } from '@mithic/commons';

const HASH_KEY = 'hash-key';
const RANGE_KEY = 'range-key';
const KEY1 = 'key1';
const KEY2 = 'key2';
const VALUE1 = 'value1';
const VALUE2 = 'value2';
const OPTIONS = { signal: AbortSignal.timeout(100) };

describe(RedisMap.name, () => {
  let map: RedisMap;
  let mockRedis: RedisClientType;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    map = new RedisMap(mockRedis, HASH_KEY, RANGE_KEY, false);
    await map.start();
  });

  afterEach(async () => {
    await map.close();
  });

  it('should be started', () => {
    expect(map.started).toBe(true);
  });

  it('should have the correct string tag', () => {
    expect(`${map}`).toBe(`[object ${RedisMap.name}]`);
  });

  describe('close', () => {
    it('should set started to false', async () => {
      await map.close();
      expect(map.started).toBe(false);
    });
  });

  describe('get', () => {
    it('gets a value via Redis client', async () => {
      jest.mocked(mockRedis.hGet).mockReturnValueOnce(Promise.resolve(VALUE1));
      expect(await map.get(KEY1, OPTIONS)).toEqual(VALUE1);
      expect(mockRedis.hGet).toHaveBeenCalledWith(commandOptions({ ...OPTIONS, returnBuffers: false }), HASH_KEY, KEY1);
    });
  });

  describe('has', () => {
    it('returns true if value exists', async () => {
      jest.mocked(mockRedis.hGet).mockReturnValueOnce(Promise.resolve(VALUE1));
      expect(await map.has(KEY1, OPTIONS)).toBe(true);
      expect(mockRedis.hGet).toHaveBeenCalledWith(commandOptions(OPTIONS), HASH_KEY, KEY1);
    });

    it('returns false if value not exist', async () => {
      jest.mocked(mockRedis.hGet).mockReturnValueOnce(Promise.resolve(void 0));
      expect(await map.has(KEY1, OPTIONS)).toBe(false);
      expect(mockRedis.hGet).toHaveBeenCalledWith(commandOptions(OPTIONS), HASH_KEY, KEY1);
    });
  });
  
  describe('set', () => {
    it('set a key via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);

      await map.set(KEY1, VALUE1);
      expect(multiMock.hSet).toHaveBeenCalledWith(HASH_KEY, KEY1, VALUE1);
      expect(multiMock.zAdd).toHaveBeenCalledWith(RANGE_KEY, { value: KEY1, score: 0 });
      expect(multiMock.exec).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes an existing key via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);
      jest.mocked(multiMock.exec).mockResolvedValueOnce([1]);

      expect(await map.delete(KEY1)).toBe(true);
      expect(multiMock.hDel).toHaveBeenCalledWith(HASH_KEY, KEY1);
      expect(multiMock.zRem).toHaveBeenCalledWith(RANGE_KEY, KEY1);
    });

    it('returns false if a key does not exist', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);
      jest.mocked(multiMock.exec).mockResolvedValueOnce([0]);
      expect(await map.delete(KEY1)).toBe(false);
    });
  });

  describe('getMany', () => {
    it('gets values via Redis client', async () => {
      jest.mocked(mockRedis.hmGet).mockReturnValueOnce(Promise.resolve([VALUE1, VALUE2]));
      const results = [];
      for await (const value of map.getMany([KEY1, KEY2], OPTIONS)) {
        results.push(value);
      }
      expect(results).toEqual([VALUE1, VALUE2]);
      expect(mockRedis.hmGet).toHaveBeenCalledWith(commandOptions({ ...OPTIONS, returnBuffers: false }), HASH_KEY, [KEY1, KEY2]);
    });
  });

  describe('hasMany', () => {
    it('returns true if value exists and false otherwise', async () => {
      jest.mocked(mockRedis.hmGet).mockReturnValueOnce(Promise.resolve([VALUE1, void 0] as string[]));
      const results = [];
      for await (const value of map.hasMany([KEY1, KEY2], OPTIONS)) {
        results.push(value);
      }
      expect(results).toEqual([true, false]);
      expect(mockRedis.hmGet).toHaveBeenCalledWith(commandOptions({ ...OPTIONS, returnBuffers: false }), HASH_KEY, [KEY1, KEY2]);
    });
  });

  describe('setMany', () => {
    it('sets values via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);

      const entries: [string, string][] = [[KEY1, VALUE1], [KEY2, VALUE2]];
      for await (const error of map.setMany(entries)) {
        expect(error).toBeUndefined();
      }
      expect(multiMock.hSet).toHaveBeenCalledWith(HASH_KEY, entries);
      expect(multiMock.zAdd).toHaveBeenCalledWith(RANGE_KEY, [{ value: KEY1, score: 0 }, { value: KEY2, score: 0 }]);
      expect(multiMock.exec).toHaveBeenCalled();
    });

    it('returns errors from Redis call', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);
      jest.mocked(multiMock.exec).mockRejectedValueOnce('error');

      const results = [];
      for await (const error of map.setMany([[KEY1, VALUE1], [KEY2, VALUE2]])) {
        results.push(error);
      }
      expect(results).toEqual([operationError('Failed to set', ErrorCode.OpFailed, KEY1, 'error'), operationError('Failed to set', ErrorCode.OpFailed, KEY2, 'error')]);
    });
  });

  describe('deleteMany', () => {
    it('deletes values via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);

      const keys = [KEY1, KEY2];
      for await (const error of map.deleteMany(keys)) {
        expect(error).toBeUndefined();
      }
      expect(multiMock.hDel).toHaveBeenCalledWith(HASH_KEY, keys);
      expect(multiMock.zRem).toHaveBeenCalledWith(RANGE_KEY, keys);
      expect(multiMock.exec).toHaveBeenCalled();
    });

    it('returns errors from Redis call', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);
      jest.mocked(multiMock.exec).mockRejectedValueOnce('error');

      const results = [];
      for await (const error of map.deleteMany([KEY1, KEY2])) {
        results.push(error);
      }
      expect(results).toEqual([operationError('Failed to delete', ErrorCode.OpFailed, KEY1, 'error'), operationError('Failed to delete', ErrorCode.OpFailed, KEY2, 'error')]);
    });
  });

  describe('updateMany', () => {
    it('sets or deletes values via Redis client', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);

      const entries: [string, string | undefined][] = [[KEY1, VALUE1], [KEY2, void 0]];
      for await (const error of map.updateMany(entries)) {
        expect(error).toBeUndefined();
      }
      expect(multiMock.hSet).toHaveBeenCalledWith(HASH_KEY, [[KEY1, VALUE1]]);
      expect(multiMock.zAdd).toHaveBeenCalledWith(RANGE_KEY, [{ value: KEY1, score: 0 }]);
      expect(multiMock.hDel).toHaveBeenCalledWith(HASH_KEY, [KEY2]);
      expect(multiMock.zRem).toHaveBeenCalledWith(RANGE_KEY, [KEY2]);
      expect(multiMock.exec).toHaveBeenCalled();
    });

    it('returns errors from Redis call', async () => {
      const multiMock = createMockRedisClientMultiCommand();
      jest.mocked(mockRedis.multi).mockReturnValueOnce(multiMock);
      jest.mocked(multiMock.exec).mockRejectedValueOnce('error');

      const results = [];
      for await (const error of map.updateMany([[KEY1, VALUE1], [KEY2, void 0]])) {
        results.push(error);
      }
      expect(results).toEqual([operationError('Failed to update', ErrorCode.OpFailed, KEY1, 'error'), operationError('Failed to update', ErrorCode.OpFailed, KEY2, 'error')]);
    });
  });

  describe('keys', () => {
    it.each([
      [OPTIONS as RangeQueryOptions<string>, ['-', '+', void 0, void 0] as [string, string, boolean | undefined, { offset: number, count: number } | undefined]],
      [{ ...OPTIONS, gte: 'a', lt: 'b' }, ['[a', '(b', void 0, void 0]],
      [{ ...OPTIONS, gt: 'a', lte: 'b' }, ['(a', '[b', void 0, void 0]],
      [{ ...OPTIONS, gt: 'a', lt: 'b', reverse: true, limit: 100 }, ['(b', '(a', true, { offset: 0, count: 100 }]],
    ])('returns zRange result from Redis client', async (options, [start, end, REV, LIMIT]) => {
      jest.mocked(mockRedis.zRange).mockReturnValueOnce(Promise.resolve([KEY1, KEY2]));
      const results = [];
      for await (const value of map.keys(options)) {
        results.push(value);
      }
      expect(results).toEqual([KEY1, KEY2]);
      expect(mockRedis.zRange).toHaveBeenCalledWith(commandOptions(OPTIONS), RANGE_KEY, start, end, { BY: 'LEX', REV, LIMIT });
    });
  });

  describe('values', () => {
    it('returns zRange result from Redis client', async () => {
      jest.mocked(mockRedis.zRange).mockReturnValueOnce(Promise.resolve([KEY1, KEY2]));
      jest.mocked(mockRedis.hmGet).mockReturnValueOnce(Promise.resolve([VALUE1, VALUE2]));
      const results = [];
      for await (const entry of map.values({ ...OPTIONS, gt: 'a', lt: 'b', reverse: true, limit: 100 })) {
        results.push(entry);
      }
      expect(results).toEqual([VALUE1, VALUE2]);
      expect(mockRedis.zRange).toHaveBeenCalledWith(commandOptions(OPTIONS), RANGE_KEY, '(b', '(a', { BY: 'LEX', REV: true, LIMIT: { offset: 0, count: 100 } });
      expect(mockRedis.hmGet).toHaveBeenCalledWith(commandOptions({ ...OPTIONS, returnBuffers: false }), HASH_KEY, [KEY1, KEY2]);
    });
  });

  describe('entries', () => {
    it('returns zRange result from Redis client', async () => {
      jest.mocked(mockRedis.zRange).mockReturnValueOnce(Promise.resolve([KEY1, KEY2]));
      jest.mocked(mockRedis.hmGet).mockReturnValueOnce(Promise.resolve([VALUE1, VALUE2]));
      const results = [];
      for await (const entry of map.entries({ ...OPTIONS, gt: 'a', lt: 'b', reverse: true, limit: 100 })) {
        results.push(entry);
      }
      expect(results).toEqual([[KEY1, VALUE1], [KEY2, VALUE2]]);
      expect(mockRedis.zRange).toHaveBeenCalledWith(commandOptions(OPTIONS), RANGE_KEY, '(b', '(a', { BY: 'LEX', REV: true, LIMIT: { offset: 0, count: 100 } });
      expect(mockRedis.hmGet).toHaveBeenCalledWith(commandOptions({ ...OPTIONS, returnBuffers: false }), HASH_KEY, [KEY1, KEY2]);
    });
  });

  describe('asyncIterator', () => {
    it('returns zRange result from Redis client', async () => {
      jest.mocked(mockRedis.zRange).mockReturnValueOnce(Promise.resolve([KEY1, KEY2]));
      jest.mocked(mockRedis.hmGet).mockReturnValueOnce(Promise.resolve([VALUE1, VALUE2]));
      const results = [];
      for await (const entry of map) {
        results.push(entry);
      }
      expect(results).toEqual([[KEY1, VALUE1], [KEY2, VALUE2]]);
      expect(mockRedis.zRange).toHaveBeenCalledWith(commandOptions({}), RANGE_KEY, '-', '+', { BY: 'LEX' });
      expect(mockRedis.hmGet).toHaveBeenCalledWith(commandOptions({ returnBuffers: false }), HASH_KEY, [KEY1, KEY2]);
    });
  });
});
