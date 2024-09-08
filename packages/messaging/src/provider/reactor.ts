import {
  delay, dispose, type SharedChannelBuffers, type Startable, type SyncMessageChannel, SyncMessageChannelReactor
} from '@mithic/commons';
import { MessagingMessage, MessagingOp } from './codec.ts';
import { MessagingError, MessagingErrorType, type Message, type MessagingErrorPayload } from '../types.ts';
import type { MessagingService } from './adapter.ts';
import { BroadcastChannelMessagingService } from '../impl/index.ts';

const ABORT_ERROR_NAME = 'AbortError';
const DEFAULT_TIMEOUT_MS = 5000;
const TICK_MS = 200;

/** 
 * Reactor to process messaging service operations.
 * TODO: currently if multiple clients subscribe to the same topic, only the last client will get incoming messages.
 * Use multiple reactors to support multiple clients per topic.
 */
export class MessagingReactor implements Startable, Disposable {
  private readonly reactor: SyncMessageChannelReactor<MessagingMessage>;
  private readonly service: MessagingService;
  private readonly subscriptions = new Map<SyncMessageChannel<MessagingMessage>, Set<string>>();
  private readonly subscribers = new Map<string, SyncMessageChannel<MessagingMessage>>();
  private readonly results = new Map<number, MessagingErrorPayload | undefined>();
  private readonly now: () => number;
  private readonly handlerTimeoutMs: number;
  private seq = 0;

  public constructor({
    now = () => performance.now(),
    handlerTimeoutMs = DEFAULT_TIMEOUT_MS,
    service = new BroadcastChannelMessagingService(),
    start = true,
    send,
    recv,
  }: MessagingProviderOptions = {}) {
    this.handlerTimeoutMs = handlerTimeoutMs;
    this.now = now;
    this.service = service;
    if (service) {
      service.onmessage = this.onmessage;
    }

    this.reactor = new SyncMessageChannelReactor({
      codec: MessagingMessage,
      onmessage: this.handle,
      send, recv, start
    });
    this.reactor.onremovechannel = this.onremovechannel;
  }

  public [Symbol.dispose](): void {
    dispose(this.reactor);
  }

  public start(): void {
    this.reactor.start();
  }

  public get started(): boolean {
    return this.reactor.started;
  }

  /**
   * Sets or creates a new channel for client, and returns the shared channel buffers to use by the client.
   * Each channel buffer is only valid for single client-reactor connection.
   */
  public addChannel(buffers?: SharedChannelBuffers): SharedChannelBuffers {
    return this.reactor.addChannel(buffers);
  }

  /** Removes a channel by its shared channel buffers. */
  public removeChannel(buffers: SharedChannelBuffers): void {
    this.reactor.removeChannel(buffers);
  }

  private onremovechannel = (channel: SyncMessageChannel<MessagingMessage>) => {
    for (const topic of this.subscriptions.get(channel) ?? []) {
      this.subscribers.delete(topic);
    }
    this.subscriptions.delete(channel);
  }

  private handle = async (channel: SyncMessageChannel<MessagingMessage>, message: MessagingMessage) => {
    try {
      switch (message.op) {
        case MessagingOp.Response:
          this.results.set(message.seq, message.error);
          break;
        case MessagingOp.Message: {
          await this.onClientMessage(channel, message);
          break;
        }
        case MessagingOp.Subscribe: {
          await this.onClientSubscribe(channel, message);
          break;
        }
        case MessagingOp.Subscriber:
          await channel.sendAsync({
            op: MessagingOp.Response, seq: message.seq,
            peers: (await this.service.subscribers?.(message.topic)) || []
          });
          break;
      }
    } catch (e) {
      const error = ((e as Error)?.name === ABORT_ERROR_NAME) ? { tag: MessagingErrorType.Timeout } :
        (e instanceof MessagingError && e.payload) || { tag: MessagingErrorType.Other, val: `internal error: ${e}` };
      await channel.sendAsync({ op: MessagingOp.Response, seq: message.seq, error });
    }
  };

  private async onClientMessage(
    channel: SyncMessageChannel<MessagingMessage>,
    message: MessagingMessage & { op: typeof MessagingOp.Message }
  ): Promise<void> {
    if (message.expectedReplies) {
      if (!this.service.request) { throw new MessagingError({ tag: MessagingErrorType.Unsupported }); }
      const msgs = await this.service.request(message.msg, {
        expectedReplies: message.expectedReplies,
        timeoutMs: message.timeoutMs ?? this.handlerTimeoutMs,
      });
      await channel.sendAsync({ op: MessagingOp.Response, seq: message.seq, msgs });
      return;
    }

    if (message.replyTo) {
      if (!this.service.reply) { throw new MessagingError({ tag: MessagingErrorType.Unsupported }); }
      await this.service.reply(message.replyTo, message.msg);
    } else {
      await this.service.send(message.msg);
    }
    await channel.sendAsync({ op: MessagingOp.Response, seq: message.seq });
  }

  private async onClientSubscribe(
    channel: SyncMessageChannel<MessagingMessage>,
    message: MessagingMessage & { op: typeof MessagingOp.Subscribe }
  ): Promise<void> {
    const topics = new Set(message.topics);
    await this.service.subscribe([...topics]);
    this.subscriptions.set(channel, topics);
    for (const topic of topics) {
      this.subscribers.set(topic, channel);
    }
    await channel.sendAsync({ op: MessagingOp.Response, seq: message.seq });
  }

  private onmessage = async (msg: Message, timeoutMs?: number) => {
    const start = this.now(), seq = this.seq++;
    const channel = this.subscribers.get(msg.topic);
    if (!channel) { return; }

    await channel.sendAsync({ op: MessagingOp.Message, seq, msg, timeoutMs }, timeoutMs ?? this.handlerTimeoutMs);

    while (!this.checkResponse(seq)) {
      await delay(this.nextTick(start, timeoutMs ?? this.handlerTimeoutMs));
    }
  };

  private checkResponse(seq: number): boolean {
    if (!this.results.has(seq)) {
      return false;
    }
    const result = this.results.get(seq);
    this.results.delete(seq);
    if (result) {
      throw new MessagingError(result);
    }
    return true;
  }

  private nextTick(start: number, timeoutMs: number): number {
    const timeRemaining = timeoutMs - (this.now() - start);
    assert(timeRemaining > 0, { tag: MessagingErrorType.Timeout });
    return Math.min(TICK_MS, timeRemaining);
  }
}

/** Options for creating {@link MessagingReactor}. */
export interface MessagingProviderOptions extends Partial<SharedChannelBuffers> {
  /** The backing messaging service. */
  readonly service?: MessagingService;
  /** Start on construct? */
  readonly start?: boolean;
  /** Message handler timeout limit in milliseconds. Defaults to 5s. */
  readonly handlerTimeoutMs?: number;
  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;
}

function assert(cond: unknown, error: MessagingErrorPayload): asserts cond {
  if (!cond) { throw new MessagingError(error); }
}
