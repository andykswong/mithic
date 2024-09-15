import { mock } from 'node:test';

/** Mock Redis client. */
class MockRedisClient {
  /** @type {Map<string, Map<string, Buffer>>} */
  hashes = new Map();
  /** @type {Map<string, [string, number][]>} */
  ranges = new Map();

  isReady = false;

  connect() {
    this.isReady = true;
    return Promise.resolve(this);
  }

  quit() {
    this.isReady = false;
    return Promise.resolve('OK');
  }

  subscribe = mock.fn(async () => void 0);
  unsubscribe = mock.fn(async () => void 0);
  publish = mock.fn(async () => 1);
  pubSubChannels = mock.fn(async () => []);
  executeIsolated = mock.fn((async () => { }));

  hGet = mock.fn(async () => void 0);
  hSet = mock.fn(async () => 1);
  hDel = mock.fn(async () => 1);
  hIncrBy = mock.fn(async () => 0);
  hmGet = mock.fn(async () => []);
  type = mock.fn((async () => 'none'));
  watch = mock.fn(async () => 'OK');
  zAdd = mock.fn(async () => 1);
  zRem = mock.fn(async () => 1);
  zRange = mock.fn(async () => []);

  multi = mock.fn(() => createMockRedisClientMultiCommand());
}

/**
 * @returns {import('@redis/client').RedisClientType}
 */
export function createMockRedisClient() {
  return new MockRedisClient();
}

/**
 * @returns {ReturnType<import('@redis/client').RedisClientType['multi']>}
 */
export function createMockRedisClientMultiCommand() {
  const result = {
    set: mock.fn(() => result),
    hSet: mock.fn(() => result),
    hDel: mock.fn(() => result),
    zAdd: mock.fn(() => result),
    zRem: mock.fn(() => result),
    expire: mock.fn(() => result),
    exec: mock.fn(async () => []),
  };
  return result;
}
