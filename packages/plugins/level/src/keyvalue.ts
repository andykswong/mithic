import { arrayCompare, AtomicSemaphore, dispose, type Error, LockGuard, type Startable } from '@mithic/commons';
import {
  KeyOrder, type KeyResponse, type KeySelector, type KeyValueProvider, type KeyValueStore
} from '@mithic/keyvalue';
import type { AbstractSublevel, AbstractLevel } from 'abstract-level';

const DEFAULT_TIMEOUT_MS = 5000;
const NOT_FOUND = 'LEVEL_NOT_FOUND';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sublevel = AbstractSublevel<AbstractLevel<any, string, Uint8Array>, any, string, Uint8Array>;

/** {@link KeyValueProvider} backed by {@link AbstractLevel} sublevels. */
export class LevelKeyValueProvider implements KeyValueProvider, AsyncDisposable, Startable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly level: AbstractLevel<any, string, Uint8Array>;
  private readonly batchSize: number;
  private readonly semaphore: AtomicSemaphore;
  private readonly timeoutMs: number;

  public constructor({
    level,
    batchSize = 100,
    semaphore = (() => {
      const semaphore = new AtomicSemaphore();
      semaphore.notify();
      return semaphore;
    })(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: LevelKeyValueProviderOptions) {
    this.level = level;
    this.batchSize = batchSize;
    this.semaphore = semaphore;
    this.timeoutMs = timeoutMs;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.level.close();
  }

  public get started(): boolean {
    return this.level.status === 'open';
  }

  public async start(): Promise<void> {
    await this.level.open();
  }

  public async open(identifier: string): Promise<LevelKeyValueStore> {
    if (!this.started) {
      await this.start();
    }
    const sublevel: Sublevel = this.level.sublevel(identifier, { keyEncoding: 'utf8', valueEncoding: 'view' });
    return new LevelKeyValueStore(sublevel, this.batchSize, this.semaphore, this.timeoutMs);
  }
}

/** {@link KeyValueStore} backed by {@link AbstractLevel} sublevels. */
export class LevelKeyValueStore implements KeyValueStore {
  private readonly level: Sublevel;
  private readonly batchSize: number;
  private readonly semaphore: AtomicSemaphore;
  private readonly timeoutMs: number;

  public constructor(level: Sublevel, batchSize: number, semaphore: AtomicSemaphore, timeoutMs: number) {
    this.level = level;
    this.batchSize = batchSize;
    this.semaphore = semaphore;
    this.timeoutMs = timeoutMs;
  }

  public get [Symbol.toStringTag](): string {
    return LevelKeyValueStore.name;
  }

  public async listKeys(selector?: KeySelector, cursor?: string): Promise<KeyResponse> {
    const keys: string[] = await this.level.keys(getKeysOptions(this.batchSize + 1, selector, cursor)).all();
    let newCursor;
    if (keys.length > this.batchSize) {
      newCursor = keys[this.batchSize - 1];
      keys.length = this.batchSize;
    }
    return { keys, cursor: newCursor };
  }

  public async exists(key: string): Promise<boolean> {
    try {
      return (await this.level.get(key)) !== undefined;
    } catch (e) {
      if ((e as Error)?.code === NOT_FOUND) {
        return false;
      }
      throw e;
    }
  }

  public async getMany(keys: string[]): Promise<(Uint8Array | null)[]> {
    return (await this.level.getMany(keys)).map(undefinedAsNull);
  }

  public async updateMany(keyValues: [key: string, value: Uint8Array | null][]): Promise<void> {
    const sublevel = this.level;
    let batch = sublevel.batch();
    for (const [key, value] of keyValues) {
      if (value) {
        batch = batch.put(key, value);
      } else {
        batch = batch.del(key);
      }
    }
    await batch.write();
  }

  public async increment(key: string, delta: bigint): Promise<bigint> {
    const sublevel = this.level;
    const lock = await LockGuard.acquire(this.semaphore, this.timeoutMs);
    try {
      // below uses getMany instead of get to avoid NotFound error in some implementations
      const existingValue = (await sublevel.getMany([key]))[0];
      const newValue = new Uint8Array(8);
      if (existingValue) {
        newValue.set(existingValue);
      }
      const view = new DataView(newValue.buffer, newValue.byteOffset, newValue.byteLength);
      const result = view.getBigInt64(0, true) + delta;
      view.setBigInt64(0, result, true);
      await sublevel.put(key, newValue);
      return result;
    } finally {
      dispose(lock);
    }
  }

  public async compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): Promise<boolean> {
    const sublevel = this.level;
    const lock = await LockGuard.acquire(this.semaphore, this.timeoutMs);
    try {
      // below uses getMany instead of get to avoid NotFound error in some implementations
      const existingValue = (await sublevel.getMany([key]))[0];
      if ((!oldValue && existingValue) ||
        (oldValue && (!(existingValue instanceof Uint8Array) || arrayCompare(oldValue, existingValue) !== 0))
      ) {
        return false;
      }

      if (!newValue) {
        await sublevel.del(key);
      } else {
        await sublevel.put(key, newValue);
      }
      return true;
    } finally {
      dispose(lock);
    }
  }
}

/** Options for creating a {@link LevelKeyValueProvider}. */
export interface LevelKeyValueProviderOptions {
  /** Backing {@link AbstractLevel} store. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly level: AbstractLevel<any, string, Uint8Array>,
  /** The batch size for listKeys operation. Defaults to 100. */
  readonly batchSize?: number;
  /** The semaphore to use for atomic operations. */
  readonly semaphore?: AtomicSemaphore;
  /** The timeout for atomic operations in milliseconds. Defaults to 5000. */
  readonly timeoutMs?: number;
}

function undefinedAsNull<T>(value: T | undefined): T | null {
  return value ?? null;
}

function getKeysOptions(limit: number, selector?: KeySelector, cursor?: string) {
  const reverse = selector?.order === KeyOrder.Desc;
  let lower = selector?.start;
  let upper = selector?.end;
  let lowerOpen = false;

  if (cursor !== undefined) {
    if (reverse) {
      upper = upper === undefined || cursor < upper ? cursor : upper;
    } else {
      lower = lower === undefined || cursor > lower ? cursor : lower;
      if (lower === cursor) {
        lowerOpen = true;
      }
    }
  }

  const result: Record<string, unknown> = { reverse, limit };
  if (lower !== undefined) {
    if (lowerOpen) {
      result.gt = lower;
    } else {
      result.gte = lower;
    }
  }
  if (upper !== undefined) {
    result.lt = upper;
  }
  return result;
}
