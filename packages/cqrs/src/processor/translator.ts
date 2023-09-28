import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription } from '../bus.js';
import { MessageProcessor } from '../processor.js';

/** {@link MessageProcessor} that handles input message and translates it to output message. */
export class MessageTranslator<SrcMsg, OutMsg = SrcMsg> extends MessageProcessor<SrcMsg> {
  public constructor(
    /** Source {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg>,
    /** Output {@link MessageDispatcher} to use. */
    dispatcher: MessageDispatcher<OutMsg>,
    /** Message handler. */
    handler: (msg: SrcMsg, options?: AbortOptions) => MaybePromise<OutMsg | undefined>,
  ) {
    const consumer = async (msg: SrcMsg, options?: AbortOptions) => {
      const outMsg = await handler(msg, options);
      return outMsg && dispatcher.dispatch(outMsg, options);
    };
    super(subscription, consumer);
  }
}
