import { AbortOptions } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription } from '@mithic/messaging';
import { MessageProcessor } from '../processor.ts';
import { MessageTransformHandler } from '../handler.ts';

/** {@link MessageProcessor} that handles input message and transforms it to output message. */
export class MessageTransformer<SrcMsg, OutMsg = SrcMsg, HandlerOpts = object>
  extends MessageProcessor<SrcMsg, HandlerOpts> {

  public constructor(
    /** Source {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg, HandlerOpts>,
    /** Output {@link MessageDispatcher} to use. */
    dispatcher: MessageDispatcher<OutMsg>,
    /** Message handler. */
    handler: MessageTransformHandler<SrcMsg, OutMsg, HandlerOpts>,
  ) {
    const consumer = async (msg: SrcMsg, options?: AbortOptions & HandlerOpts) => {
      const outMsg = await handler(msg, options);
      return outMsg && dispatcher.dispatch(outMsg, options);
    };
    super(subscription, consumer);
  }
}
