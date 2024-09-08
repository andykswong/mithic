import { decode } from 'cbor-x/decode';
import { encode } from 'cbor-x/encode';
import { type Codec, type Startable } from '@mithic/commons';
import {
  isMessage, RequestReplyHelper, type Message, type MessageHandler, type MessagingService, type RequestOptions
} from '@mithic/messaging';
import { type RedisClientType } from '@redis/client';

/** Redis pub/sub implementation of {@link MessagingService}. */
export class RedisPubSubMessagingService<R extends RedisClientType = RedisClientType>
  implements MessagingService, Startable, AsyncDisposable {

  public onmessage: MessageHandler | null = null;
  private readonly client: R;
  private readonly requestReplyHelper: RequestReplyHelper;
  private readonly codec: Codec<Message>;
  private _topics = new Set<string>();

  public constructor({
    client,
    now = () => performance.now(),
    replyTopic,
    randomId = () => crypto.randomUUID(),
    codec = { encode, decode },
  }: RedisPubSubMessagingServiceOptions<R>) {
    this.client = client;
    this.codec = codec;
    this.requestReplyHelper = new RequestReplyHelper({
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

  public async send(message: Message): Promise<void> {
    await this.client.publish(message.topic, Buffer.from(this.codec.encode(message)));
  }

  public request(request: Message, options?: RequestOptions): Promise<Message[]> {
    return this.requestReplyHelper.request(request, options);
  }

  public reply(request: Message, reply: Message): Promise<void> {
    return this.requestReplyHelper.reply(request, reply);
  }

  public async subscribe(topics: string[]): Promise<void> {
    const newTopics = topics.filter(topic => !this._topics.has(topic));
    const removedTopics = Array.from(this._topics).filter(topic => !topics.includes(topic));
    for (const topic of newTopics) {
      await this.client.subscribe(topic, this.handle, true);
    }
    for (const topic of removedTopics) {
      await this.client.unsubscribe(topic, this.handle, true);
    }
    this._topics = new Set(topics);
  }

  /** Returns the subscribed topics. */
  public topics(): Promise<string[]> {
    return this.client.pubSubChannels();
  }

  private handle = async (msg: Uint8Array) => {
    const message = this.codec.decode(msg);
    if (!isMessage(message)) { return; }
    this.requestReplyHelper.accept(message);
    if (this._topics.has(message.topic)) {
      try {
        return await this.onmessage?.(message);
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
  readonly codec?: Codec<Message>;
}
