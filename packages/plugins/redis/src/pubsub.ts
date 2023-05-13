import { AbortOptions, Startable } from '@mithic/commons';
import { MessageHandler, MessageValidatorResult, PubSub, PubSubMessage, SubscribeOptions } from '@mithic/messaging';
import { RedisClientType, commandOptions } from '@redis/client';
import { RedisValueType } from './type.js';

/** Redis implementation of {@link PubSub}. */
export class RedisPubSub<UseBuffer extends boolean = false, R extends RedisClientType = RedisClientType>
  implements PubSub<UseBuffer extends true ? Buffer : string>, Startable {

  public constructor(
    /** Redis client to use. */
    protected readonly client: R,
    /** Whether to use buffers for messages. */
    protected readonly useBuffer?: UseBuffer,
  ) {
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
    topic: string,
    handler: MessageHandler<PubSubMessage<RedisValueType<UseBuffer>>>,
    options?: SubscribeOptions<PubSubMessage<RedisValueType<UseBuffer>>>
  ): Promise<void> {
    const validator = options?.validator;
    await this.client.subscribe(topic, async (data) => {
      const message = { topic, data };
      if (!validator || await validator(message) === MessageValidatorResult.Accept) {
        return handler(message);
      }
    }, this.useBuffer);
  }

  public async unsubscribe(topic: string): Promise<void> {
    await this.client.unsubscribe(topic);
  }

  public async publish(topic: string, message: RedisValueType<UseBuffer>, options: AbortOptions = {}): Promise<void> {
    await this.client.publish(commandOptions(options), topic, message);
  }

  public topics(options: AbortOptions = {}): Promise<string[]> {
    return this.client.pubSubChannels(commandOptions(options));
  }
}
