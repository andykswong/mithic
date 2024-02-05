import { maybeAsync } from '@mithic/commons';
import { MessageBus, MessageHandler, MessageOptions, SubscribeOptions, Unsubscribe } from '../messaging.ts';

/** Simple in-memory implementation of {@link MessageBus}. */
export class SimpleMessageBus<Message> implements MessageBus<Message> {
  private readonly handlers = new Map<string, MessageHandler<Message>[]>();

  public constructor(
    /** Name of the default topic. */
    public readonly defaultTopic = 'message'
  ) {
  }

  public dispatch = maybeAsync(this.coDispatch, this);

  public subscribe(handler: MessageHandler<Message>, options?: SubscribeOptions<Message>): Unsubscribe {
    const topic = options?.topic ?? this.defaultTopic;
    const validator = options?.validator;
    const validatedHandler: MessageHandler<Message> = maybeAsync(function* (message, options) {
      if (!(yield validator?.(message, options))) {
        return handler(message, options);
      }
    });
    this.handlers.set(topic, [...(this.handlers.get(topic) || []), validatedHandler]);

    return () => {
      const handlers = this.handlers.get(topic);
      const index = handlers?.indexOf(validatedHandler) ?? -1;
      index >= 0 && handlers?.splice(index, 1);
    };
  }

  private * coDispatch(this: SimpleMessageBus<Message>, message: Message, options?: MessageOptions) {
    const topic = options?.topic ?? this.defaultTopic;
    const handlers = this.handlers.get(topic) || [];
    for (const handler of handlers) {
      yield handler(message, { topic });
    }
  }
}
