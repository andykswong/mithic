import { EventDispatcher, TypedCustomEvent, TypedEventTarget, createEvent, maybeAsync } from '@mithic/commons';
import { MessageBus, MessageHandler, MessageOptions, SubscribeOptions, Unsubscribe } from '../messaging.js';

/** Implementation of {@link MessageBus} that wraps an EventTarget. */
export class EventTargetMessageBus<Msg> implements MessageBus<Msg> {
  public constructor(
    /** Underlying dispatcher to use. */
    private readonly dispatcher: EventDispatcher<[TypedCustomEvent<string, Msg>]> =
      new TypedEventTarget<[TypedCustomEvent<string, Msg>]>(),
    /** Name of the default event type to emit. */
    public readonly defaultTopic = 'event'
  ) {
    this.dispatch = this.dispatch.bind(this);
  }

  public dispatch(message: Msg, options?: MessageOptions): void {
    const topic = options?.topic ?? this.defaultTopic;
    this.dispatcher.dispatchEvent(createEvent(topic, message));
  }

  public subscribe(handler: MessageHandler<Msg>, options?: SubscribeOptions<Msg>): Unsubscribe {
    const topic = options?.topic ?? this.defaultTopic;
    const validator = options?.validator;
    const listener = maybeAsync(function* (event: TypedCustomEvent<string, Msg>) {
      if (!(yield validator?.(event.detail, { topic }))) {
        return handler(event.detail, { topic });
      }
    });
    this.dispatcher.addEventListener(topic, listener);
    return () => this.dispatcher.removeEventListener(topic, listener);
  }
}
