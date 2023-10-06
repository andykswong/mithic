import { MessageHandler, SubscribeOptions, MessageValidator, MessageBus, Unsubscribe } from '@mithic/messaging';

export const LIBP2P_KEY_CODE = 0x72;

export class MockMessageBus<Msg = Uint8Array> implements MessageBus<Msg> {
  topicHandlers = new Map<string, MessageHandler<Msg>>();
  topicValidators = new Map<string, MessageValidator<Msg>>();

  subscribe(handler: MessageHandler<Msg>, options?: SubscribeOptions<Msg>): Unsubscribe {
    const topic = options?.topic ?? '';
    this.topicHandlers.set(topic, handler);
    options?.validator && this.topicValidators.set(topic, options.validator);
    return () => this.unsubscribe(topic);
  }

  unsubscribe(topic: string): void {
    this.topicHandlers.delete(topic);
    this.topicValidators.delete(topic);
  }

  dispatch(): void {
    // NO-OP
  }

  topics(): Iterable<string> {
    return this.topicHandlers.keys();
  }

  close(): void {
    // NOOP
  }
}
