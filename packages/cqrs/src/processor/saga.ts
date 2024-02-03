import { AbortOptions, maybeAsync } from '@mithic/commons';
import { MessageProcessor } from '../processor.ts';
import { MessageDispatcher, MessageSubscription } from '@mithic/messaging';
import { MessageSagaHandler } from '../handler.ts';

/** {@link MessageProcessor} that handles messages and dispatches more messages. */
export class SagaProcessor<SrcMsg, OutMsg = SrcMsg, HandlerOpts = object>
  extends MessageProcessor<SrcMsg, HandlerOpts> {

  public constructor(
    /** Source {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg, HandlerOpts>,
    /** Output {@link MessageDispatcher} to use. */
    dispatcher: MessageDispatcher<OutMsg>,
    /** Saga function. */
    saga: MessageSagaHandler<SrcMsg, OutMsg, HandlerOpts>,
  ) {
    const consumer = maybeAsync(function* (event: SrcMsg, options?: AbortOptions & HandlerOpts) {
      const iter = saga(event, options);
      for (let result: IteratorResult<OutMsg> = yield iter.next(); !result.done; result = yield iter.next()) {
        yield dispatcher.dispatch(yield result.value);
      }
    });
    super(subscription, consumer);
  }
}
