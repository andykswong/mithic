import { EventEmitter, TypedEventEmitter } from '@mithic/commons';
import { MessageBus, MessageConsumer, Unsubscribe } from '../bus.js';

/** Simple implementation of {@link MessageBus} that wraps an EventEmitter. */
export class SimpleMessageBus<Message> implements MessageBus<Message> {
  public constructor(
    /** Underlying emitter to use. */
    private readonly emitter: TypedEventEmitter<Record<string, [Message]>>
      = new EventEmitter<Record<string, [Message]>>(),
    /** Name of the event type to emit. */
    private readonly eventName = 'event'
  ) {
    this.dispatch = this.dispatch.bind(this);
  }

  public dispatch(message: Message): void {
    this.emitter.emit(this.eventName, message);
  }

  public subscribe(consumer: MessageConsumer<Message>): Unsubscribe {
    this.emitter.addListener(this.eventName, consumer);
    return () => this.unsubscribe(consumer);
  }

  /** Unsubscribes consumer from new events. */
  public unsubscribe(consumer: MessageConsumer<Message>): void {
    this.emitter.removeListener(this.eventName, consumer);
  }
}
