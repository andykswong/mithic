import { dispose, SyncMessageChannel, type SharedChannelBuffers, type Startable } from '@mithic/commons';
import type { SyncKeyValueProvider, SyncKeyValueStore } from '../../service.ts';
import { StoreError, StoreErrorType, type StoreErrorPayload } from '../../types.ts';
import { KVStoreMessage, KVStoreOp } from './codec.ts';

const DEFAULT_TIMEOUT_MS = 5000;
const TICK_MS = 1000;

/** Provider of synchronous keyvalue store through remote call via message channel. */
export class KeyValueStoreClient implements Startable, Disposable, SyncKeyValueProvider {
  private readonly stores = new Map<string, SyncKeyValueStore>();
  private readonly messageChannel: SyncMessageChannel<KVStoreMessage>;
  private readonly responses = new Map<number, (KVStoreMessage & { op: typeof KVStoreOp.Response }) | undefined>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private seq = 0;

  public constructor({
    send, recv, start,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => performance.now(),
  }: KeyValueStoreClientOptions = {}) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.messageChannel = new SyncMessageChannel({
      receiver: false,
      codec: KVStoreMessage,
      onmessage: this.handle,
      send, recv,
      start
    });
  }

  public [Symbol.dispose](): void {
    dispose(this.messageChannel);
  }

  public start(): void {
    this.messageChannel.start();
  }

  public get started(): boolean {
    return this.messageChannel.started;
  }

  /** Returns the shared channel buffers of the provider. */
  public get channel(): SharedChannelBuffers {
    return this.messageChannel.buffers;
  }

  /**
   * Blocking waits until at least 1 incoming message is processed or timeout,
   * and returns the number of messages being processed.
   */
  public blockingProcess(timeoutMs?: number): number {
    return this.messageChannel.blockingProcess(timeoutMs);
  }

  /** Processes incoming I/O responses and returns the number of messages being processed. */
  public process(): number {
    return this.messageChannel.process();
  }

  /** Blocks until send queue is flushed or timeout, and returns if the operation is successful. */
  public flush(timeoutMs?: number): boolean {
    return this.messageChannel.flush(timeoutMs);
  }

  public open(bucket: string): SyncKeyValueStore {
    let store = this.stores.get(bucket);
    if (store) { return store; }

    const response = this.requestResponse({ op: KVStoreOp.Open, seq: this.seq++, bucket });
    assert(response.bucket, { tag: StoreErrorType.NoSuchStore });
    store = {
      [Symbol.dispose]: () => {
        this.request({ op: KVStoreOp.Close, seq: this.seq++, bucket });
        this.stores.delete(bucket);
      },
      exists: (key) => {
        const response = this.requestResponse({ op: KVStoreOp.Exist, seq: this.seq++, bucket, key });
        return !!response.success;
      },
      listKeys: (selector, cursor) => {
        const response = this.requestResponse({ op: KVStoreOp.Keys, seq: this.seq++, bucket, selector, cursor });
        return { keys: response.keys ?? [], cursor: response.cursor };
      },
      getMany: (keys) => {
        if (!keys.length) { return []; }
        const response = this.requestResponse({ op: KVStoreOp.Get, seq: this.seq++, bucket, keys });
        return response.values || [];
      },
      updateMany: (keyValues) => {
        if (!keyValues.length) { return; }
        this.requestResponse({ op: KVStoreOp.Update, seq: this.seq++, bucket, keyValues });
      },
      increment: (key, delta) => {
        const response = this.requestResponse({ op: KVStoreOp.Incr, seq: this.seq++, bucket, key, delta });
        assert(response.counter, { tag: StoreErrorType.Other, val: `failed to increment key ${key}` });
        return response.counter;
      },
      compareAndSwap: (key, oldValue, newValue) => {
        const response = this.requestResponse({ op: KVStoreOp.CAS, seq: this.seq++, bucket, key, oldValue, newValue });
        return !!response.success;
      }
    } satisfies SyncKeyValueStore;

    this.stores.set(bucket, store);
    return store;
  }

  private requestResponse(
    msg: KVStoreMessage, start = this.now(), timeoutMs = this.timeoutMs
  ): KVStoreMessage & { op: typeof KVStoreOp.Response } {
    try {
      this.responses.set(msg.seq, undefined);
      this.request(msg, start, timeoutMs);
      return this.waitForResponse(msg.seq, start, timeoutMs);
    } finally {
      this.responses.delete(msg.seq);
    }
  }

  private request(msg: KVStoreMessage, start = this.now(), timeoutMs = this.timeoutMs) {
    while (!this.messageChannel.send(msg)) {
      this.flush(nextTick(this.now(), start, timeoutMs));
    }
  }

  private waitForResponse(
    seq: number, start: number, timeoutMs = this.timeoutMs
  ): KVStoreMessage & { op: typeof KVStoreOp.Response } {
    let response: KVStoreMessage & { op: typeof KVStoreOp.Response } | undefined;
    while (!(response = this.responses.get(seq))) {
      this.blockingProcess(nextTick(this.now(), start, timeoutMs));
    }
    assert(response, { tag: StoreErrorType.Timeout });
    if (response.error) {
      throw new StoreError(response.error);
    }
    return response;
  }

  private handle = (message: KVStoreMessage) => {
    if (message.op === KVStoreOp.Response && this.responses.has(message.seq)) {
      this.responses.set(message.seq, message);
      return;
    }
  };
}

/** Options for creating {@link KeyValueStoreClient}. */
export interface KeyValueStoreClientOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  readonly start?: boolean;
  /** Global operation timeout limit in milliseconds. Defaults to 5s. */
  readonly timeoutMs?: number;
  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;
}

function assert(cond: unknown, error: StoreErrorPayload): asserts cond {
  if (!cond) { throw new StoreError(error); }
}

function nextTick(now: number, start: number, timeoutMs: number): number {
  const timeRemaining = timeoutMs - (now - start);
  assert(timeRemaining > 0, { tag: StoreErrorType.Timeout });
  return Math.min(TICK_MS, timeRemaining);
}
