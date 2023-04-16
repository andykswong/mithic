import { MessageHandler, PubSub, PubSubMessage, SubscribeOptions, MessageValidator } from '@mithic/messaging';

export const LIBP2P_KEY_CODE = 0x72;

export class MockPubSub implements PubSub<Uint8Array> {
  topicHandlers = new Map<string, MessageHandler<PubSubMessage<Uint8Array>>>();
  topicValidators = new Map<string, MessageValidator<PubSubMessage<Uint8Array>>>();

  subscribe(topic: string, handler: MessageHandler<PubSubMessage<Uint8Array>>, options?: SubscribeOptions<PubSubMessage<Uint8Array>>): void {
    this.topicHandlers.set(topic, handler);
    options?.validator && this.topicValidators.set(topic, options.validator);
  }

  unsubscribe(topic: string): void {
    this.topicHandlers.delete(topic);
    this.topicValidators.delete(topic);
  }

  publish(): void {
    // NO-OP
  }

  topics(): Iterable<string> {
    return this.topicHandlers.keys();
  }

  close(): void {
    // NOOP
  }
}
