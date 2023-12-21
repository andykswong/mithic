import { Kv, KvKey } from '@deno/kv';
import { DisposableCloseable } from '@mithic/commons';
import {
  MessageBus, MessageHandler, MessageOptions, MessageSubscriptionTopics, SubscribeOptions, Unsubscribe
} from '@mithic/messaging';

const DEFAULT_TOPIC = 'message';

/** Deno KV implementation of {@link MessageBus}. */
export class DenoKVMessageBus<T = unknown> extends DisposableCloseable
  implements MessageBus<T>, MessageSubscriptionTopics, Disposable {

  private readonly topicHandlers = new Map<string, MessageHandler<T>[]>();
  protected started = true;
  protected listened = false;

  public constructor(
    /** Redis client to use. */
    protected readonly kv: Kv,
    /** The default topic to publish to. */
    public readonly defaultTopic = DEFAULT_TOPIC,
  ) {
    super();
  }

  public close(): void {
    if (this.started) {
      this.kv.close();
      this.started = false;
    }
  }

  public async dispatch(message: T, options?: DenoKVMessageOptions): Promise<void> {
    const topic = options?.topic ?? this.defaultTopic;
    await this.kv.enqueue({ topic, data: message } satisfies DenoKVMessage<T>, {
      delay: options?.delay,
      keysIfUndelivered: options?.keysIfUndelivered,
    });
  }

  public async subscribe(handler: MessageHandler<T>, options?: SubscribeOptions<T>): Promise<Unsubscribe> {
    const topic = options?.topic ?? this.defaultTopic;
    const validator = options?.validator;

    const validatedHandler = async (message: T) => {
      if (!(await validator?.(message, { topic }))) {
        return handler(message, { topic });
      }
    };

    const handlers = this.topicHandlers.get(topic) ?? [];
    handlers.push(validatedHandler);
    this.topicHandlers.set(topic, handlers);

    if (!this.listened) {
      this.kv.listenQueue(this.handle);
      this.listened = true;
    }

    return () => {
      const handlers = this.topicHandlers.get(topic);
      if (!handlers) { return; }
      const index = handlers.indexOf(validatedHandler);
      index >= 0 && handlers.splice(index, 1);
      !handlers.length && this.topicHandlers.delete(topic);
    }
  }

  public topics(): IterableIterator<string> {
    return this.topicHandlers.keys();
  }

  private handle = async (message: unknown) => {
    if ((message as DenoKVMessage<T>)?.topic === void 0) { return; }
    const msg = message as DenoKVMessage<T>;
    const handlers = this.topicHandlers.get(msg.topic) ?? [];
    for (const handler of handlers) {
      await handler(msg.data);
    }
  }
}

/** Message options for {@link DenoKVMessageBus}. */
export interface DenoKVMessageOptions extends MessageOptions {
  /** The delay (in milliseconds) of the value delivery */
  delay?: number;
  /** The keys to be set if the value is not successfully delivered after several attempts. */
  keysIfUndelivered?: KvKey[];
}

/** Internal message format for {@link DenoKVMessageBus}. */
export interface DenoKVMessage<Msg = unknown> {
  topic: string;
  data: Msg;
}
