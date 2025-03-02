import {
  delay, dispose, type SharedChannelBuffers, type Startable, type SyncMessageChannel, SyncMessageChannelReactor
} from '@mithic/commons';
import type { MessagingService } from '../../service.ts';
import { MessagingError, MessagingErrorType, type Message, type MessageHandler, type MessagingErrorPayload } from '../../types.ts';
import { getErrorPayload } from '../../utils/index.ts';
import { MessagingMessage, MessagingOp } from './codec.ts';

const DEFAULT_TIMEOUT_MS = 5000;
const TICK_MS = 200;

/** Reactor to process {@link MessagingService} operations from clients through message channel. */
export class MessagingReactor implements Startable, Disposable {
  private readonly reactor: SyncMessageChannelReactor<MessagingMessage>;
  private readonly service: MessagingService;
  /** Channel to handle ID to handler map. */
  private readonly subscriptions = new Map<SyncMessageChannel<MessagingMessage>, Map<number, MessageHandler>>();
  /** Op seq ID to result (error) map. */
  private readonly results = new Map<number, MessagingErrorPayload | undefined>();
  private readonly now: () => number;
  private readonly handlerTimeoutMs: number;
  private seq = 0;

  public constructor({
    service,
    now = () => performance.now(),
    handlerTimeoutMs = DEFAULT_TIMEOUT_MS,
    start = true,
    send,
    recv,
  }: MessagingProviderOptions) {
    this.service = service;
    this.handlerTimeoutMs = handlerTimeoutMs;
    this.now = now;
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
    const subscriptions = this.subscriptions.get(channel);
    this.subscriptions.delete(channel);
    for (const handler of subscriptions?.values() || []) {
      this.service.subscribe([], handler);
    }
  };

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
            peers: (await this.service.listSubscribers?.(message.topic)) || []
          });
          break;
      }
    } catch (e) {
      await channel.sendAsync({ op: MessagingOp.Response, seq: message.seq, error: getErrorPayload(e) });
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
    const handleId = message.handle || 0;
    const topics = new Set(message.topics);

    const handlerMap = this.subscriptions.get(channel) || new Map<number, MessageHandler>();
    let handler = handlerMap.get(handleId);
    if (!handler && topics.size) {
      handler = this.createHandler(channel, handleId);
      handlerMap.set(handleId, handler);
      this.subscriptions.set(channel, handlerMap);
    }
    if (handler) {
      await this.service.subscribe([...topics], handler);
      if (!topics.size) {
        handlerMap.delete(handleId);
        if (!handlerMap.size) {
          this.subscriptions.delete(channel);
        }
      }
    }
    await channel.sendAsync({ op: MessagingOp.Response, seq: message.seq });
  }

  private createHandler(channel: SyncMessageChannel<MessagingMessage>, handle = 0): MessageHandler {
    return {
      handle: async (msg: Message) => {
        const start = this.now(), seq = this.seq++;
        await channel.sendAsync(
          { op: MessagingOp.Message, seq, handle, msg, timeoutMs: this.handlerTimeoutMs },
          this.handlerTimeoutMs
        );
        try {
          while (!this.checkResponse(seq)) {
            await delay(this.nextTick(start, this.handlerTimeoutMs));
          }
        } finally {
          this.results.delete(seq);
        }
      }
    };
  };

  private checkResponse(seq: number): boolean {
    if (!this.results.has(seq)) {
      return false;
    }
    const result = this.results.get(seq);
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
  readonly service: MessagingService;
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
