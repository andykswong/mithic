import { AbortOptions, MaybeAsyncIterableIterator, maybeAsync } from '@mithic/commons';
import { MessageProcessor } from '../processor.js';
import { MessageDispatcher, MessageSubscription } from '@mithic/messaging';

/** {@link MessageProcessor} that handles messages and dispatches more messages. */
export class SagaProcessor<SrcMsg, OutMsg = SrcMsg> extends MessageProcessor<SrcMsg> {
  public constructor(
    /** Source {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<SrcMsg>,
    /** Output {@link MessageDispatcher} to use. */
    dispatcher: MessageDispatcher<OutMsg>,
    /** Saga function. */
    saga: (msg: SrcMsg, options?: AbortOptions) => MaybeAsyncIterableIterator<OutMsg>,
  ) {
    const consumer = maybeAsync(function* (event: SrcMsg, options?: AbortOptions) {
      const iter = saga(event, options);
      for (let result: IteratorResult<OutMsg> = yield iter.next(); !result.done; result = yield iter.next()) {
        yield dispatcher.dispatch(yield result.value);
      }
    });
    super(subscription, consumer);
  }
}
