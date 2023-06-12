import { AbortOptions, MaybePromise, maybeAsync } from '@mithic/commons';
import { resolve } from '@mithic/commons/maybeAsync';
import { PubSub, PubSubMessage } from '@mithic/messaging';
import { MessageBus, MessageConsumer } from '../bus.js';

/**
 * An {@link MessageBus} implementation using a PubSub.
 * When there are multiple subscribers, they are executed sequentially.
 */
export class PubSubMessageBus<Message> implements MessageBus<Message> {
  protected readonly consumers: Array<MessageConsumer<Message>> = [];

  public constructor(
    /** Underlying PubSub instance. */
    protected readonly pubsub: PubSub<Message>,
    /** PubSub topic name to use. */
    protected readonly topic: string = '/mithic-bus/0.1.0',
  ) {
    this.dispatch = this.dispatch.bind(this);
    this.consumer = this.consumer.bind(this);
  }

  public dispatch(message: Message, options?: AbortOptions): MaybePromise<void> {
    return this.pubsub.publish(this.topic, message, options);
  }

  public subscribe = maybeAsync(function* (
    this: PubSubMessageBus<Message>, consumer: MessageConsumer<Message>, options?: AbortOptions
  ) {
    yield* resolve(!this.consumers.length ? this.pubsub.subscribe(this.topic, this.consumer, options) : void 0);
    this.consumers.push(consumer);
    return (options?: AbortOptions) => this.unsubscribe(consumer, options);
  }, this);

  /** Unsubscribes consumer from new messages. */
  public unsubscribe(consumer: MessageConsumer<Message>, options?: AbortOptions): MaybePromise<void> {
    const idx = this.consumers.indexOf(consumer);
    if (idx < 0) {
      return;
    }
    this.consumers.splice(idx, 1);
    if (!this.consumers.length) {
      return this.pubsub.unsubscribe(this.topic, options);
    }
  }

  protected async consumer(msg: PubSubMessage<Message>) {
    for (const consumer of this.consumers) {
      await consumer(msg.data);
    }
  }
}
