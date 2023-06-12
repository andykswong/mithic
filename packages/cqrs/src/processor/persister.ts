import { MessageSubscription, MessageTransformer } from '../bus.js';
import { MessageProcessor } from '../processor.js';
import { AbortOptions, MaybePromise } from '@mithic/commons';

/** {@link MessageProcessor} that persists message using an {@link ObjectWriter}. */
export class MessagePersister<Msg, SrcMsg = Msg>
  extends MessageProcessor<SrcMsg>
{
  public constructor(
    /** {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg>,
    /** Event store writer to use. */
    writer: ObjectWriter<Msg>,
    /** Function to transform incoming events for storage. */
    transform: MessageTransformer<SrcMsg, Msg> = identity,
  ) {
    const consumer = async (msg: SrcMsg) => {
      const targetEvent = await transform(msg);
      targetEvent && await writer.put(targetEvent);
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
