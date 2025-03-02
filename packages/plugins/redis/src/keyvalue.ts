import { arrayCompare, type Startable } from '@mithic/commons';
import {
  KeyOrder, StoreError, StoreErrorType, type KeyResponse, type KeySelector, type KeyValueProvider, type KeyValueStore
} from '@mithic/keyvalue';
import { commandOptions, WatchError, type RedisClientType } from '@redis/client';

/** Redis implementation of {@link KeyValueProvider}. */
export class RedisKeyValueProvider<R extends RedisClientType = RedisClientType> implements
  KeyValueProvider, Startable, AsyncDisposable {

  private readonly client: R;
  private readonly batchSize: number;
  private readonly rangeKey: (bucket: string) => string;
  private readonly signalKey: (bucket: string, key: string) => string;

  public constructor(
    /** Redis client to use. */
    client: R,
    /** Batch size for listKeys operation. */
    batchSize = 100,
    /** Return the Redis key for storing key range for a bucket. */
    rangeKey = (bucket: string) => `${bucket}:keys`,
    /** Return the Redis key used as a watch signal key for change detection. */
    signalKey = (bucket: string, key: string) => `${bucket}:signal:${key}`,
  ) {
    this.client = client;
    this.batchSize = batchSize;
    this.rangeKey = rangeKey;
    this.signalKey = signalKey;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.client.quit();
  }

  public get started(): boolean {
    return this.client.isReady;
  }

  public async start(): Promise<void> {
    await this.client.connect();
  }

  public async open(identifier: string): Promise<RedisKeyValueStore<R>> {
    if (!this.started) {
      await this.start();
    }
    const type = await this.client.type(identifier);
    if (type !== 'hash' && type !== 'none') {
      throw new StoreError({ tag: StoreErrorType.NoSuchStore });
    }
    return new RedisKeyValueStore(this.client, identifier, this.batchSize, this.rangeKey, this.signalKey);
  }
}

/** Redis implementation of {@link KeyValueStore}. */
export class RedisKeyValueStore<R extends RedisClientType = RedisClientType> implements KeyValueStore {

  private readonly client: R;
  private readonly batchSize: number;
  private readonly rangeKey: (bucket: string) => string;
  private readonly signalKey: (bucket: string, key: string) => string;

  public readonly name: string;

  public constructor(
    /** Redis client to use. */
    client: R,
    /** The bucket name. */
    name: string,
    /** Batch size for listKeys operation. */
    batchSize: number,
    /** Return the Redis key for storing key range for a bucket. */
    rangeKey: (bucket: string) => string,
    /** Return the Redis key used as a watch signal key for change detection. */
    signalKey: (bucket: string, key: string) => string,
  ) {
    this.name = name;
    this.client = client;
    this.batchSize = batchSize;
    this.rangeKey = rangeKey;
    this.signalKey = signalKey;
  }

  public get [Symbol.toStringTag](): string {
    return RedisKeyValueStore.name;
  }

  public async exists(key: string): Promise<boolean> {
    return (await this.client.hGet(this.name, key) !== undefined);
  }

  public async listKeys(selector?: KeySelector, cursor?: string): Promise<KeyResponse> {
    const reverse = selector?.order === KeyOrder.Desc;
    let start = selector?.start === undefined ? '-' : '[' + selector.start;
    let end = selector?.end === void 0 ? '+' : '(' + selector.end;
    if (reverse) {
      [start, end] = [end, start];
    }
    if (cursor) {
      start = '(' + cursor;
    }

    const keys = await this.client.zRange(
      this.rangeKey(this.name),
      start, end,
      {
        BY: 'LEX',
        REV: reverse ? true : undefined,
        LIMIT: { offset: 0, count: this.batchSize + 1 },
      }
    );
    let nextCursor: string | undefined;
    if (keys.length > this.batchSize) {
      nextCursor = keys[this.batchSize - 1];
      keys.length = this.batchSize;
    }
    return { keys, cursor: nextCursor };
  }


  public async getMany(keys: string[]): Promise<(Uint8Array | null)[]> {
    const results: (Uint8Array | null)[] = [];
    for (const value of await this.client.hmGet(commandOptions({ returnBuffers: true }), this.name, keys)) {
      results.push(value ? value : null);
    }
    return results;
  }

  public async updateMany(keyValues: [key: string, value: Uint8Array | null][]): Promise<void> {
    const rangeKey = this.rangeKey(this.name);
    const addedEntries: [string, Buffer][] = [];
    const deletedKeys = [];
    for (const [key, value] of keyValues) {
      if (!value) {
        deletedKeys.push(key);
      } else {
        addedEntries.push([key, Buffer.from(value)]);
      }
    }

    await this.client.multi()
      .hSet(this.name, addedEntries)
      .hDel(this.name, deletedKeys)
      .zAdd(rangeKey, addedEntries.map(([key]) => ({ value: key, score: 0 })))
      .zRem(rangeKey, deletedKeys)
      .exec();
  }

  public async increment(key: string, delta: bigint): Promise<bigint> {
    // TODO: use bigint to avoid precision loss
    return BigInt(await this.client.hIncrBy(this.name, key, Number(delta)));
  }

  public async compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): Promise<boolean> {
    const signalKey = this.signalKey(this.name, key);
    try {
      return await this.client.executeIsolated(async client => {
        await client.watch(signalKey);

        const value = await client.hGet(commandOptions({ returnBuffers: true }), this.name, key);
        if ((!value && oldValue) || (value && (!oldValue || arrayCompare(value, oldValue) !== 0))) {
          return false;
        }

        const multi = client.multi()
          .set(signalKey, '')
          .expire(signalKey, 60);
        if (newValue) {
          multi.hSet(this.name, key, Buffer.from(newValue));
        } else {
          multi.hDel(this.name, key);
        }
        await multi.exec();

        return true;
      });
    } catch (e) {
      if (e instanceof WatchError) {
        return false;
      }
      throw e;
    }
  }
}
