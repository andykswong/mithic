import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageSubscription } from '@mithic/messaging';
import { MessageProcessor } from '../processor.ts';
import { ObjectWriter } from '../handler.ts';

/** {@link MessageProcessor} that persists message using an {@link ObjectWriter}. */
export class MessagePersister<Msg, SrcMsg = Msg, HandlerOpts = object> extends MessageProcessor<SrcMsg, HandlerOpts> {
  public constructor(
    /** {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg, HandlerOpts>,
    /** Event store writer to use. */
    writer: ObjectWriter<unknown, Msg, HandlerOpts>,
    /** Function to translate incoming events for storage. */
    translate: (src: SrcMsg, options?: AbortOptions & HandlerOpts) => MaybePromise<Msg | undefined> = identity,
  ) {
    const consumer = async (msg: SrcMsg, options?: AbortOptions & HandlerOpts) => {
      const targetEvent = await translate(msg, options);
      targetEvent && await writer.put(targetEvent, options);
    };
    super(subscription, consumer);
  }
}

function identity<T, U>(value: T): U {
  return value as unknown as U;
}
