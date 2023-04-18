import { AbortOptions, Startable, maybeAsync } from '@mithic/commons';
import { resolve } from '@mithic/commons/maybeAsync';
import { EventConsumer, EventSubscription, Unsubscribe } from './event.js';

/** Processor of events from an {@link EventSubscription}. */
export class EventProcessor<Event = unknown> implements Startable {
  private handle: Unsubscribe | undefined;

  public constructor(
    /** {@link EventSubscription} to consume. */
    protected readonly subscription: EventSubscription<Event>,
    /** Consumer of events. */
    protected readonly consumer: EventConsumer<Event>
  ) {
  }

  public get started(): boolean {
    return !!this.handle;
  }

  public start = maybeAsync(function* (this: EventProcessor<Event>, options?: AbortOptions) {
    this.handle = yield* resolve(this.subscription.subscribe(this.consumer, options));
  }, this);

  public close = maybeAsync(function* (this: EventProcessor<Event>, options?: AbortOptions) {
    if (this.handle) {
      yield* resolve(this.handle(options));
      this.handle = void 0;
    }
  }, this);
}
