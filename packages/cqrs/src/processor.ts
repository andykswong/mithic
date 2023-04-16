import { AbortOptions, MaybePromise, Startable, mapAsync } from '@mithic/commons';
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

  public start(options?: AbortOptions): MaybePromise<void> {
    return mapAsync(this.subscription.subscribe(this.consumer, options), this.setHandle);
  }

  public close(options?: AbortOptions): MaybePromise<void> {
    if (this.handle) {
      return mapAsync(this.handle(options), this.deleteHandle);
    }
  }

  private setHandle = (unsubscribe: Unsubscribe) => {
    this.handle = unsubscribe;
  }

  private deleteHandle = () => {
    this.handle = void 0;
  }
}
