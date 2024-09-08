import { dispose, SyncMessageChannel, type SharedChannelBuffers, type Startable } from '@mithic/commons';
import type { KeyValueApiProvider, KeyValueStore } from './adapter.ts';
import { KVStoreMessage, KVStoreOp } from './codec.ts';
import { type KeyResponse, type KeySelector, StoreError, StoreErrorType, type StoreErrorPayload } from '../types.ts';

const DEFAULT_TIMEOUT_MS = 5000;
const TICK_MS = 1000;

/** Provider of synchronous keyvalue store API through a remote reactor. */
export class RemoteKeyValueStore implements Startable, Disposable, KeyValueStore, KeyValueApiProvider {
  private readonly messageChannel: SyncMessageChannel<KVStoreMessage>;
  private readonly responses = new Map<number, KVStoreMessage & { op: typeof KVStoreOp.Response }>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private seq = 0;

  public constructor({
    send, recv, start,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => performance.now(),
  }: RemoteKeyValueStoreOptions = {}) {
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

  public open(identifier: string): string {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Open, seq, bucket: identifier }, start);
    const response = this.waitForResponse(seq, start);
    assert(response.bucket, { tag: StoreErrorType.NoSuchStore });
    return response.bucket;
  }

  public close(bucket: string): void {
    const seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Close, seq, bucket }, this.now());
  }

  public exists(bucket: string, key: string): boolean {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Exist, seq, bucket, key }, start);
    const response = this.waitForResponse(seq, start);
    return !!response.success;
  }

  public listKeys(bucket: string, selector?: KeySelector, cursor?: string): KeyResponse {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Keys, seq, bucket, selector, cursor }, start);
    const response = this.waitForResponse(seq, start);
    return { keys: response.keys ?? [], cursor: response.cursor };
  }

  public getMany(bucket: string, keys: string[]): (Uint8Array | null)[] {
    if (!keys.length) { return []; }
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Get, seq, bucket, keys }, start);
    const response = this.waitForResponse(seq, start);
    return response.values || [];
  }

  public updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): void {
    if (!keyValues.length) { return; }
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Update, seq, bucket, keyValues }, start);
    this.waitForResponse(seq, start);
  }

  public increment(bucket: string, key: string, delta: bigint): bigint {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.Incr, seq, bucket, key, delta }, start);
    const response = this.waitForResponse(seq, start);
    assert(response.counter, { tag: StoreErrorType.Other, val: `failed to increment key ${key}` });
    return response.counter;
  }

  public compareAndSwap(bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: KVStoreOp.CAS, seq, bucket, key, oldValue, newValue }, start);
    const response = this.waitForResponse(seq, start);
    return !!response.success;
  }

  private sendRequest(msg: KVStoreMessage, start: number, timeoutMs = this.timeoutMs) {
    while (!this.messageChannel.send(msg)) {
      this.flush(this.nextTick(start, timeoutMs));
    }
  }

  private waitForResponse(
    seq: number, start: number, timeoutMs = this.timeoutMs
  ): KVStoreMessage & { op: typeof KVStoreOp.Response } {
    let response: KVStoreMessage & { op: typeof KVStoreOp.Response } | undefined;
    while (!(response = this.responses.get(seq))) {
      this.blockingProcess(this.nextTick(start, timeoutMs));
    }
    this.responses.delete(seq);
    assert(response, { tag: StoreErrorType.Timeout });
    if (response.error) {
      throw new StoreError(response.error);
    }
    return response;
  }

  private nextTick(start: number, timeoutMs: number): number {
    const timeRemaining = timeoutMs - (this.now() - start);
    assert(timeRemaining > 0, { tag: StoreErrorType.Timeout });
    return Math.min(TICK_MS, timeRemaining);
  }

  private handle = (message: KVStoreMessage) => {
    if (message.op === KVStoreOp.Response) {
      this.responses.set(message.seq, message);
      return;
    }
  };
}

/** Options for creating {@link RemoteKeyValueStore}. */
export interface RemoteKeyValueStoreOptions extends Partial<SharedChannelBuffers> {
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
