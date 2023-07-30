import { EventDispatcher, TypedCustomEvent, TypedEventTarget, createEvent } from '@mithic/commons';
import { MessageBus, MessageConsumer, Unsubscribe } from '../bus.js';

/** Simple implementation of {@link MessageBus} that wraps an EventTarget. */
export class SimpleMessageBus<Message> implements MessageBus<Message> {
  public constructor(
    /** Underlying dispatcher to use. */
    private readonly dispatcher: EventDispatcher<[TypedCustomEvent<string, Message>]> =
      new TypedEventTarget<[TypedCustomEvent<string, Message>]>(),
    /** Name of the event type to emit. */
    private readonly eventName = 'event'
  ) {
    this.dispatch = this.dispatch.bind(this);
  }

  public dispatch(message: Message): void {
    this.dispatcher.dispatchEvent(createEvent(this.eventName, message));
  }

  public subscribe(consumer: MessageConsumer<Message>): Unsubscribe {
    const listener = (event: TypedCustomEvent<string, Message>) => consumer(event.detail);
    this.dispatcher.addEventListener(this.eventName, listener);
    return () => this.dispatcher.removeEventListener(this.eventName, listener);
  }
}
