import { AbortOptions, AsyncDisposableCloseable, Startable, maybeAsync } from '@mithic/commons';
import {
  MessageBus, MessageHandler, MessageOptions, MessageSubscriptionTopics, SubscribeOptions, Unsubscribe
} from '@mithic/messaging';
import { RedisClientType, commandOptions } from '@redis/client';
import { RedisValueType } from './type.js';

const DEFAULT_TOPIC = 'message';

/** Redis implementation of {@link MessageBus}. */
export class RedisMessageBus<UseBuffer extends boolean = false, R extends RedisClientType = RedisClientType>
  extends AsyncDisposableCloseable
  implements MessageBus<RedisValueType<UseBuffer>>, MessageSubscriptionTopics, Startable, AsyncDisposable {

  public constructor(
    /** Redis client to use. */
    protected readonly client: R,
    /** Whether to use buffers for messages. */
    protected readonly useBuffer?: UseBuffer,
    /** The default topic to publish to. */
    public readonly defaultTopic = DEFAULT_TOPIC,
  ) {
    super();
  }

  public get started(): boolean {
    return this.client.isReady;
  }

  public async start(): Promise<void> {
    await this.client.connect();
  }

  public async close(): Promise<void> {
    await this.client.quit();
  }

  public async subscribe(
    handler: MessageHandler<RedisValueType<UseBuffer>>,
    options?: SubscribeOptions<RedisValueType<UseBuffer>>
  ): Promise<Unsubscribe> {
    const topic = options?.topic ?? this.defaultTopic;
    const validator = options?.validator;
    const listener = maybeAsync(function* (message: RedisValueType<UseBuffer>) {
      if (!(yield validator?.(message, { topic }))) {
        return handler(message, { topic });
      }
    });
    await this.client.subscribe(topic, listener, this.useBuffer);
    return () => this.client.unsubscribe(topic, listener, this.useBuffer);
  }

  public async dispatch(message: RedisValueType<UseBuffer>, options?: MessageOptions): Promise<void> {
    const { topic = this.defaultTopic, ...cmdOptions } = options ?? {};
    await this.client.publish(commandOptions(cmdOptions), topic, message);
  }

  public topics(options?: AbortOptions): Promise<string[]> {
    return this.client.pubSubChannels(commandOptions(options ?? {}));
  }
}
