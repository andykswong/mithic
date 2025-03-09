import { decode } from 'cbor-x/decode';
import { encode } from 'cbor-x/encode';
import type { MaybePromise, Codec, Startable } from '@mithic/commons';
import { isMessageRecord, RequestReplyAdapter } from '@mithic/messaging';
import { Message, type MessageHandler, type MessageRecord, type MessagingService, type RequestOptions } from '@mithic/messaging';
import type { RedisClientType } from '@redis/client';

/** Redis pub/sub implementation of {@link MessagingService} with at-most-once delivery. */
export class RedisPubSubMessagingService<R extends RedisClientType = RedisClientType>
implements MessagingService, Startable, AsyncDisposable {

  private readonly client: R;
  private readonly requestReply: RequestReplyAdapter;
  private readonly codec: Codec<MessageRecord>;
  private readonly topicHandlers = new Map<string, MessageHandler[]>();

  public constructor({
    client,
    now = () => performance.now(),
    replyTopic,
    randomId = () => crypto.randomUUID(),
    codec = { encode, decode },
  }: RedisPubSubMessagingServiceOptions<R>) {
    this.client = client;
    this.codec = codec;
    this.requestReply = new RequestReplyAdapter({
      service: this, now, randomId, replyTopic
    });
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

  public async send(topic: string, message: Message): Promise<void> {
    const record = { ...message.toRecord(), topic } satisfies MessageRecord;
    await this.client.publish(topic, Buffer.from(this.codec.encode(record)));
  }

  public request(topic: string, request: Message, options?: RequestOptions): Promise<Message[]> {
    return this.requestReply.request(topic, request, options);
  }

  public reply(request: Message, reply: Message): MaybePromise<void> {
    return this.requestReply.reply(request, reply);
  }

  public async subscribe(topics: Iterable<string>, handler: MessageHandler): Promise<void> {
    const topicSet = new Set(topics);

    for (const topic of topicSet) {
      const handlers = this.topicHandlers.get(topic);
      if (handlers) {
        handlers.push(handler);
      } else {
        await this.client.subscribe(topic, this.handle, true);
        this.topicHandlers.set(topic, [handler]);
      }
    }

    for (const [topic, handlers] of this.topicHandlers) {
      if (topicSet.has(topic)) {
        continue;
      }
      const existing = handlers.indexOf(handler);
      if (existing >= 0) {
        handlers[existing] = handlers[handlers.length - 1];
        handlers.pop();
      }
      if (handlers.length === 0) {
        await this.client.unsubscribe(topic, this.handle, true);
        this.topicHandlers.delete(topic);
      }
    }
  }

  /** Returns the subscribed topics. */
  public topics(): Promise<string[]> {
    return this.client.pubSubChannels();
  }

  private handle = async (msg: Uint8Array) => {
    const record = this.codec.decode(msg);
    if (!isMessageRecord(record)) { return; }
    const message = Message.from(record);
    const topic = message.topic();
    if (this.requestReply.accept(message) || !topic) { return; }

    const handlers = this.topicHandlers.get(topic);
    if (handlers?.length) {
      const results = [];
      for (const handler of handlers) {
        try {
          results.push(handler.handle(message));
        } catch { /** noop */ }
      }
      try {
        await Promise.allSettled(results);
      } catch { /** noop */ }
    }
  };
}

/** Options for initializing a {@link RedisPubSubMessagingService} */
export interface RedisPubSubMessagingServiceOptions<R extends RedisClientType> {
  /** Redis client to use. */
  readonly client: R;

  /** Function to get the current epoch timestamp. Defaults to `performance.now`. */
  readonly now?: () => number;

  /** Redis pub/sub topic is used to receive message reply by default. */
  readonly replyTopic?: string;

  /** Function to generate random IDs. Defaults to `crypto.getRandomUUID`. */
  readonly randomId?: () => string;

  /** Message codec. Defaults to CBOR. */
  readonly codec?: Codec<MessageRecord>;
}
