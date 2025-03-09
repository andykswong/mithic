import { delay, type MaybePromise } from '@mithic/commons';
import type { MessagingService, RequestReply } from '../service.ts';
import { MessageMetadata, type RequestOptions } from '../types.ts';
import type { Message } from '../message.ts';
import { invalidRequest } from './error.ts';

const TICK_MS = 200;

/**
 * This class implements {@link RequestReply} interface in a generic way for any {@link MessagingService},
 * using special metadata (header) fields and a reply topic.
 */
export class RequestReplyAdapter implements RequestReply {
  public readonly replyTopic: string;

  private readonly replies = new Map<string, Message[]>();
  private readonly service: MessagingService;
  private readonly now: () => number;
  private readonly randomId: () => string;

  public constructor({
    service,
    now = () => performance.now(),
    randomId = () => crypto.randomUUID(),
    replyTopic = randomId(),
  }: RequestReplyAdapterOptions) {
    this.service = service;
    this.now = now;
    this.randomId = randomId;
    this.replyTopic = replyTopic;
  }

  public async request(topic: string, request: Message, options?: RequestOptions): Promise<Message[]> {
    const start = this.now();
    const expectedReplies = Math.max(options?.expectedReplies || 1, 1);
    const timeoutMs = options?.timeoutMs ?? Infinity;
    const requestId = request.getMetadata(MessageMetadata.RequestId) || this.randomId();
    request.addMetadata(MessageMetadata.RequestId, requestId);
    request.addMetadata(MessageMetadata.ReplyTopic, request.getMetadata(MessageMetadata.ReplyTopic) || this.replyTopic);
    this.replies.set(requestId, []);

    await this.service.send(topic, request);

    while ((this.replies.get(requestId)?.length || 0) < expectedReplies) {
      const timeRemaining = timeoutMs - (this.now() - start);
      if (timeRemaining <= 0) {
        break;
      }
      await delay(Math.min(TICK_MS, timeRemaining));
    }

    const replies = this.replies.get(requestId) || [];
    this.replies.delete(requestId);
    return replies;
  }

  public reply(request: Message, reply: Message): MaybePromise<void> {
    const correlationId = request.getMetadata(MessageMetadata.RequestId);
    const topic = request.getMetadata(MessageMetadata.ReplyTopic);
    if (correlationId === undefined || topic === undefined) {
      return invalidRequest();
    }
    reply.addMetadata(MessageMetadata.CorrelationId, correlationId);
    return this.service.send(topic, reply);
  }

  /** Checks if incoming message is a reply to active request and saves it if so. */
  public accept(message: Message): boolean {
    const correlationId = message.getMetadata(MessageMetadata.CorrelationId);
    if (correlationId && this.replies.has(correlationId)) {
      this.replies.get(correlationId)?.push(message);
      return true;
    }
    return false;
  }
}

/** Options for initializing a {@link RequestReplyAdapter}. */
export interface RequestReplyAdapterOptions {
  /** Target messaging service. */
  readonly service: MessagingService;

  /** The topic to use to receive replies. Defaults to random ID. */
  readonly replyTopic?: string;

  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;

  /** Function to generate random IDs. Defaults to `crypto.getRandomUUID`. */
  readonly randomId?: () => string;
}
