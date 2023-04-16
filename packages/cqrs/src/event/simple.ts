import { EventEmitter, TypedEventEmitter } from '@mithic/commons';
import { EventBus, EventConsumer, Unsubscribe } from '../event.js';

/** Simple implementation of {@link EventBus} that wraps an EventEmitter. */
export class SimpleEventBus<Event> implements EventBus<Event> {
  public constructor(
    /** Underlying emitter to use. */
    private readonly emitter: TypedEventEmitter<Record<string, [Event]>> = new EventEmitter<Record<string, [Event]>>(),
    /** Name of the event type to emit. */
    private readonly eventName = 'event'
  ) {
  }

  public dispatch(event: Event): void {
    this.emitter.emit(this.eventName, event);
  }

  public subscribe(consumer: EventConsumer<Event>): Unsubscribe {
    this.emitter.addListener(this.eventName, consumer);
    return () => this.unsubscribe(consumer);
  }

  /** Unsubscribes consumer from new events. */
  public unsubscribe(consumer: EventConsumer<Event>): void {
    this.emitter.removeListener(this.eventName, consumer);
  }
}
