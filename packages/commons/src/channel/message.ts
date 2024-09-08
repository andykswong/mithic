import { type MaybePromise } from '../async/index.ts';
import type { Codec } from '../codec.ts';
import type { Startable } from '../lifecycle.ts';
import { SharedArrayBufferChannel, type SharedChannelBuffers } from './buffer.ts';
import type { Channel } from './channel.ts';

const DEFAULT_BUFFER_SIZE = 8192;
const DEFAULT_TICK_MS = 1000;

/** Message channel that can deliver synchronously via a {@link SharedArrayBufferChannel}. */
export class SyncMessageChannel<T> implements Startable, Disposable, Channel<T> {
  /** Listener that is called when new message is received. */
  public onmessage: ((message: T) => MaybePromise<void>) | null = null;

  private readonly channel: SharedArrayBufferChannel;
  private readonly codec: Codec<T>;
  private readonly tickMs: number;
  private _started = false;

  public constructor({
    send = [new SharedArrayBuffer(DEFAULT_BUFFER_SIZE), 0, DEFAULT_BUFFER_SIZE],
    recv = [new SharedArrayBuffer(DEFAULT_BUFFER_SIZE), 0, DEFAULT_BUFFER_SIZE],
    onmessage,
    codec,
    receiver = false,
    start = receiver,
    tickMs = DEFAULT_TICK_MS,
  }: SyncMessageChannelOptions<T>) {
    this.channel = new SharedArrayBufferChannel({ send, recv, receiver });
    this.codec = codec;
    this.onmessage = onmessage || null;
    this.tickMs = tickMs;
    if (start) {
      this.start();
    }
  }

  public [Symbol.dispose](): void {
    this._started = false;
  }

  public start(): void {
    if (!this._started) {
      this._started = true;
      this.pollAsync();
    }
  }

  public get started(): boolean {
    return this._started;
  }

  public get maxSendSize(): number {
    return this.channel.maxSendSize;
  }

  /** Returns the shared buffers of the client for transfer to another worker. */
  public get buffers(): SharedChannelBuffers {
    return this.channel.buffers;
  }

  public send(message: T): boolean {
    const rawMsg = this.codec.encode(message);
    return this.channel.send(rawMsg);
  }

  /**
   * Aschronously sends given message to the channel, waiting for send queue to flush as needed or until timeout.
   * Returns if the message is being sent.
   */
  public async sendAsync(message: T, timeoutMs = Infinity): Promise<boolean> {
    const rawMsg = this.codec.encode(message);
    while (!this.channel.send(rawMsg)) {
      const waitMs = Math.min(this.tickMs, timeoutMs);
      await this.channel.flushAsync(waitMs);
      timeoutMs -= waitMs;
      if (timeoutMs <= 0) { return false; }
    }
    return true;
  }

  public receive(): T | undefined {
    this.channel.flush(0);
    const rawMsg = this.channel.receive();
    const message = rawMsg && this.codec.decode(rawMsg, { stream: true });
    if (message) {
      this.onmessage?.(message);
      return message;
    }
  }

  public wait(timeoutMs?: number): boolean {
    return this.channel.wait(timeoutMs);
  }

  public waitAsync(timeoutMs?: number): MaybePromise<boolean> {
    return this.channel.waitAsync(timeoutMs);
  }

  public flush(timeoutMs = Infinity): boolean {
    for (
      let waitMs = Math.min(this.tickMs, timeoutMs);
      !this.channel.flush(waitMs);
      waitMs = Math.min(this.tickMs, timeoutMs)
    ) {
      timeoutMs -= waitMs;
      if (timeoutMs <= 0) { return false; }
    }
    return true;
  }

  public async flushAsync(timeoutMs = Infinity): Promise<boolean> {
    for (
      let waitMs = Math.min(this.tickMs, timeoutMs);
      !(await this.channel.flushAsync(waitMs));
      waitMs = Math.min(this.tickMs, timeoutMs)
    ) {
      timeoutMs -= waitMs;
      if (timeoutMs <= 0) { return false; }
    }
    return true;
  }

  /** Processes available messages in recv queue and returns the number of messages being processed. */
  public process(): number {
    let count = 0;
    while (this.receive()) {
      ++count;
    }
    return count;
  }

  /**
   * Blocking waits until at least 1 incoming message is processed, or until timeout,
   * and returns the number of messages being processed.
   */
  public blockingProcess(timeoutMs = Infinity): number {
    let processed = 0;
    while ((processed = this.process()) <= 0) {
      if (timeoutMs <= 0) { break; }
      const waitMs = Math.min(this.tickMs, timeoutMs);
      this.wait(waitMs);
      timeoutMs -= waitMs;
    }
    return processed;
  }

  private async pollAsync() {
    while (this._started) {
      if (!this.process()) {
        await this.waitAsync(this.tickMs);
      }
    }
  }
}

/** Options for creating {@link SyncMessageChannel}. */
export interface SyncMessageChannelOptions<T> extends Partial<SharedChannelBuffers> {
  /** Message codec. */
  readonly codec: Codec<T>;
  /** Set to true to act as receiving side, which reverses the send/recv queues. */
  readonly receiver?: boolean;
  /** Start on construct? Defaults to true for receiver, false otherwise. */
  readonly start?: boolean;
  /** Default timeout in milliseconds to wait for I/O. Defaults to 1000 (1s). */
  readonly tickMs?: number;
  /** Listener that is called when new message is received. */
  readonly onmessage?: (message: T) => MaybePromise<void>;
}
