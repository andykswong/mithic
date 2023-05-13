import { jest } from '@jest/globals';
import { RedisClientType } from '@redis/client';

/** Mock Redis client. */
// @ts-expect-error: ignore the type of the mock client.
export class MockRedisClient implements RedisClientType {
  private readonly hashes = new Map<string, Map<string, Buffer>>();
  private readonly ranges = new Map<string, [string, number][]>();

  public isReady = false;

  public connect(): Promise<void> {
    this.isReady = true;
    return Promise.resolve();
  }

  public quit(): Promise<string> {
    this.isReady = false;
    return Promise.resolve('OK');
  }

  public subscribe = jest.fn(async () => void 0);
  public unsubscribe = jest.fn(async () => void 0);
  public publish = jest.fn(async () => 1);
  public pubSubChannels = jest.fn(async () => []);

  public hGet = jest.fn(async () => void 0);
  public hSet = jest.fn(async () => 1);
  public hDel = jest.fn(async () => 1);
  public hmGet = jest.fn(async () => []);
  public zAdd = jest.fn(async () => 1);
  public zRem = jest.fn(async () => 1);
  public zRange = jest.fn(async () => []);

  public multi = jest.fn(() => createMockRedisClientMultiCommand());
}

export function createMockRedisClient(): RedisClientType {
  return new MockRedisClient() as unknown as RedisClientType;
}

export function createMockRedisClientMultiCommand(): ReturnType<RedisClientType['multi']> {
  const result = {
    hSet: jest.fn(() => result),
    hDel: jest.fn(() => result),
    zAdd: jest.fn(() => result),
    zRem: jest.fn(() => result),
    exec: jest.fn(async () => []),
  } as unknown as ReturnType<RedisClientType['multi']>;
  return result;
}
