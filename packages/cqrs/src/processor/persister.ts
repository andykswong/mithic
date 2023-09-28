import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageSubscription } from '../bus.js';
import { MessageProcessor } from '../processor.js';

/** {@link MessageProcessor} that persists message using an {@link ObjectWriter}. */
export class MessagePersister<Msg, SrcMsg = Msg> extends MessageProcessor<SrcMsg> {
  public constructor(
    /** {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg>,
    /** Event store writer to use. */
    writer: ObjectWriter<Msg>,
    /** Function to translate incoming events for storage. */
    translate: (src: SrcMsg, options?: AbortOptions) => MaybePromise<Msg | undefined> = identity,
  ) {
    const consumer = async (msg: SrcMsg, options?: AbortOptions) => {
      const targetEvent = await translate(msg, options);
      targetEvent && await writer.put(targetEvent, options);
    };
    super(subscription, consumer);
  }
}

/** An interface for writing objects to storage. */
export interface ObjectWriter<V = unknown, K = unknown> {
  /** Puts given value and returns its key. */
  put(value: V, options?: AbortOptions): MaybePromise<K>;
}

function identity<T, U>(value: T): U {
  return value as unknown as U;
}
