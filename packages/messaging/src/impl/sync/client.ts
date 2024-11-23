import { dispose, SyncMessageChannel, type SharedChannelBuffers, type Startable } from '@mithic/commons';
import type { SyncMessagingService } from '../../service.ts';
import {
  MessagingError, MessagingErrorType, type MessageHandler, type Message, type MessagingErrorPayload, type PeerId, type RequestOptions
} from '../../types.ts';
import { getErrorPayload } from '../../utils/index.ts';
import { MessagingMessage, MessagingOp } from './codec.ts';

const DEFAULT_TIMEOUT_MS = 4000;
const TICK_MS = 1000;

/** Provider of {@link SyncMessagingService} through remote call via message channel. */
export class MessagingClient implements Startable, Disposable, SyncMessagingService {
  private readonly handlers = new Map<number, WeakRef<MessageHandler>>();
  private readonly handlerIds = new WeakMap<MessageHandler, number>();
  private readonly responses = new Map<number, (MessagingMessage & { op: typeof MessagingOp.Response }) | undefined>();
  private readonly messageChannel: SyncMessageChannel<MessagingMessage>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly handlerTimeoutMs: number;
  private seq = 0;
  private handlerSeq = 0;

  public constructor({
    send, recv,
    start = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    handlerTimeoutMs = timeoutMs,
    now = () => performance.now(),
  }: MessagingClientOptions = {}) {
    this.timeoutMs = timeoutMs;
    this.handlerTimeoutMs = handlerTimeoutMs;
    this.now = now;
    this.messageChannel = new SyncMessageChannel({
      receiver: false,
      codec: MessagingMessage,
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

  public send(msg: Message): void {
    this.sendMessage(msg);
  }

  public request(msg: Message, options: RequestOptions = {}): Message[] {
    let { timeoutMs = 0, expectedReplies = 1 } = options;
    if (expectedReplies < 1) { expectedReplies = 1; }
    timeoutMs = timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    try {
      return this.sendMessage(msg, { timeoutMs, expectedReplies }) || [];
    } catch (e) {
      if (e instanceof MessagingError && e.payload?.tag === MessagingErrorType.Timeout) {
        return [];
      }
      throw e;
    }
  }

  public reply(replyTo: Message, msg: Message): void {
    this.sendMessage(msg, undefined, replyTo);
  }

  public subscribe(topics: Iterable<string>, handler: MessageHandler): void {
    const handle = this.handlerIds.get(handler) || this.handlerSeq++;

    const topicSet = new Set(topics);
    if (!topicSet.size && !this.handlers.has(handle)) {
      return;
    }
    this.handlerIds.set(handler, handle);
    this.handlers.set(handle, new WeakRef(handler));

    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: MessagingOp.Subscribe, seq, handle, topics: [...topicSet] }, start);
    this.waitForResponse(seq, start);

    if (!topicSet.size) {
      this.handlerIds.delete(handler);
      this.handlers.delete(handle);
    }
  }

  public listSubscribers(topic: string): PeerId[] {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: MessagingOp.Subscriber, seq, topic }, start);
    const result = this.waitForResponse(seq, start);
    return result.peers || [];
  }

  private sendMessage(msg: Message, options?: RequestOptions, replyTo?: Message): Message[] | undefined {
    const start = this.now(), seq = this.seq++;
    this.sendRequest({ op: MessagingOp.Message, seq, msg, replyTo, ...options }, start);
    const response = this.waitForResponse(seq, start);
    return response.msgs;
  }

  private sendRequest(msg: MessagingMessage, start: number, timeoutMs = this.timeoutMs) {
    while (!this.messageChannel.send(msg)) {
      this.flush(this.nextTick(start, timeoutMs));
    }
    this.responses.set(msg.seq, undefined);
  }

  private waitForResponse(
    seq: number, start: number, timeoutMs = this.timeoutMs
  ): MessagingMessage & { op: typeof MessagingOp.Response } {
    let response: MessagingMessage & { op: typeof MessagingOp.Response } | undefined;
    while (!(response = this.responses.get(seq))) {
      this.blockingProcess(this.nextTick(start, timeoutMs));
    }
    this.responses.delete(seq);
    assert(response, { tag: MessagingErrorType.Timeout });
    if (response.error) {
      throw new MessagingError(response.error);
    }
    return response;
  }

  private nextTick(start: number, timeoutMs: number): number {
    const timeRemaining = timeoutMs - (this.now() - start);
    assert(timeRemaining > 0, { tag: MessagingErrorType.Timeout });
    return Math.min(TICK_MS, timeRemaining);
  }

  private handle = async (message: MessagingMessage) => {
    if (message.op === MessagingOp.Response) {
      if (this.responses.has(message.seq)) {
        this.responses.set(message.seq, message);
      }
    } else if (message.op === MessagingOp.Message) {
      return this.handleMessage(message);
    }
  };

  private async handleMessage(message: MessagingMessage & { op: typeof MessagingOp.Message }) {
    const start = this.now(), timeoutMs = message.timeoutMs ?? this.handlerTimeoutMs;
    const handle = message.handle || 0;
    const reply: MessagingMessage = { op: MessagingOp.Response, seq: message.seq };
    const handler = this.handlers.get(handle)?.deref();

    if (handler) {
      try {
        await handler.handle(message.msg);
      } catch (e) {
        reply.error = getErrorPayload(e);
      }
    }
    this.sendRequest(reply, start, timeoutMs);

    if (!handler) {
      const start = this.now(), seq = this.seq++;
      this.sendRequest({ op: MessagingOp.Subscribe, seq, handle, topics: [] }, start);
      this.waitForResponse(seq, start);
      this.handlers.delete(handle);
    }
  }
}

/** Options for creating {@link MessagingClient}. */
export interface MessagingClientOptions extends Partial<SharedChannelBuffers> {
  /** Start on construct? */
  readonly start?: boolean;
  /** Operation timeout limit in milliseconds. Defaults to 4s. */
  readonly timeoutMs?: number;
  /** Message handler specific timeout limit in milliseconds. Defaults to be `timeoutMs`. */
  readonly handlerTimeoutMs?: number;
  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;
}

function assert(cond: unknown, error: MessagingErrorPayload): asserts cond {
  if (!cond) { throw new MessagingError(error); }
}
