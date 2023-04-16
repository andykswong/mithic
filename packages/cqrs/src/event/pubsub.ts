import { AbortOptions, MaybePromise, mapAsync } from '@mithic/commons';
import { MessageHandler, PubSub, PubSubMessage } from '@mithic/messaging';
import { EventBus, EventConsumer, Unsubscribe } from '../event.js';

/**
 * An {@link EventBus} implementation using a PubSub.
 * When there are multiple subscribers, they are executed sequentially.
 */
export class PubSubEventBus<Event> implements EventBus<Event> {
  protected readonly consumers: Array<EventConsumer<Event>> = [];

  public constructor(
    /** Underlying PubSub instance. */
    protected readonly pubsub: PubSub<Event>,
    /** PubSub topic name to use. */
    protected readonly topic: string = '/mithic-eventbus/0.1.0',
  ) {
  }

  public dispatch(event: Event, options?: AbortOptions): MaybePromise<void> {
    return this.pubsub.publish(this.topic, event, options);
  }

  public subscribe(consumer: EventConsumer<Event>, options?: AbortOptions): MaybePromise<Unsubscribe> {
    const subscribe = !this.consumers.length ? this.pubsub.subscribe(this.topic, this.consumer, options) : void 0;
    return mapAsync(subscribe, () => {
      this.consumers.push(consumer);
      return (options) => this.unsubscribe(consumer, options);
    });
  }

  /** Unsubscribes consumer from new events. */
  public unsubscribe(consumer: EventConsumer<Event>, options?: AbortOptions): MaybePromise<void> {
    const idx = this.consumers.indexOf(consumer);
    if (idx < 0) {
      return;
    }
    this.consumers.splice(idx, 1);
    if (!this.consumers.length) {
      return this.pubsub.unsubscribe(this.topic, options);
    }
  }

  protected consumer: MessageHandler<PubSubMessage<Event>> = async (msg) => {
    for (const consumer of this.consumers) {
      await consumer(msg.data);
    }
  };
}
