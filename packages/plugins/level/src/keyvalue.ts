import { arrayCompare, AtomicSemaphore, dispose, LockGuard, type Startable } from '@mithic/commons';
import {
  BaseKeyValueStore, KeyOrder, StoreError, StoreErrorType, type KeyResponse, type KeySelector, type KeyValueStore
} from '@mithic/keyvalue';
import { type AbstractSublevel, type AbstractLevel } from 'abstract-level';

const DEFAULT_TIMEOUT_MS = 5000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sublevel = AbstractSublevel<AbstractLevel<any, string, Uint8Array>, any, string, Uint8Array>;

/** {@link AbstractLevel} implementation of an async queryable map. */
export class LevelKeyValueStore extends BaseKeyValueStore implements KeyValueStore, AsyncDisposable, Startable {
  private readonly sublevels = new Map<string, Sublevel>();
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
  }: LevelKeyValueStoreOptions) {
    super();
    this.level = level;
    this.batchSize = batchSize;
    this.semaphore = semaphore;
    this.timeoutMs = timeoutMs;
  }

  public get [Symbol.toStringTag](): string {
    return LevelKeyValueStore.name;
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

  public override async open(identifier: string): Promise<string> {
    if (!this.started) {
      await this.start();
    }
    if (!this.sublevels.has(identifier)) {
      this.sublevels.set(identifier, this.level.sublevel(identifier, { keyEncoding: 'utf8', valueEncoding: 'view' }));
    }
    return identifier;
  }

  public override close(bucket: string): void {
    this.sublevels.delete(bucket);
  }

  public override async listKeys(bucket: string, selector?: KeySelector, cursor?: string): Promise<KeyResponse> {
    const keys: string[] = await this.getSublevel(bucket).keys(this.getKeysOptions(selector, cursor)).all();
    let newCursor;
    if (keys.length > this.batchSize) {
      newCursor = keys[this.batchSize - 1];
      keys.length = this.batchSize;
    }
    return { keys, cursor: newCursor };
  }

  public override async getMany(bucket: string, keys: string[]): Promise<(Uint8Array | null)[]> {
    return (await this.getSublevel(bucket).getMany(keys)).map(undefinedAsNull);
  }

  public override async updateMany(
    bucket: string, keyValues: [key: string, value: Uint8Array | null][]
  ): Promise<void> {
    const sublevel = this.getSublevel(bucket);
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

  public override async increment(bucket: string, key: string, delta: bigint): Promise<bigint> {
    const sublevel = this.getSublevel(bucket);
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

  public override async compareAndSwap(
    bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array
  ): Promise<boolean> {
    const sublevel = this.getSublevel(bucket);
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

  private getSublevel(bucket: string): Sublevel {
    const sublevel = this.sublevels.get(bucket);
    if (!sublevel) {
      throw new StoreError({ tag: StoreErrorType.NoSuchStore });
    }
    return sublevel;
  }

  private getKeysOptions(selector?: KeySelector, cursor?: string) {
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

    const result: Record<string, unknown> = { reverse, limit: this.batchSize + 1 };
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
}

/** Options for creating a {@link LevelKeyValueStore}. */
export interface LevelKeyValueStoreOptions {
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
