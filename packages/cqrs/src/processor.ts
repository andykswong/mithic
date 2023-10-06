import { AbortOptions, AsyncDisposableCloseable, Startable, maybeAsync } from '@mithic/commons';
import { resolve } from '@mithic/commons/maybeAsync';
import { MessageHandler, MessageSubscription, Unsubscribe } from '@mithic/messaging';

/** Processor of messages from an {@link MessageSubscription}. */
export class MessageProcessor<Msg = unknown> extends AsyncDisposableCloseable implements Startable, AsyncDisposable {
  private handle: Unsubscribe | undefined;

  public constructor(
    /** {@link MessageSubscription} to consume. */
    protected readonly subscription: MessageSubscription<Msg>,
    /** Consumer of messages. */
    protected readonly consumer: MessageHandler<Msg>,
  ) {
    super();
  }

  public get started(): boolean {
    return !!this.handle;
  }

  public start = maybeAsync(function* (this: MessageProcessor<Msg>, options?: AbortOptions) {
    this.handle = yield* resolve(this.subscription.subscribe(this.consumer, options));
  }, this);

  public override close = maybeAsync(function* (this: MessageProcessor<Msg>, options?: AbortOptions) {
    if (this.handle) {
      yield* resolve(this.handle(options));
      this.handle = void 0;
    }
  }, this);
}
