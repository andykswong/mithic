import { EventSubscription, EventTransformer } from '../event.js';
import { EventProcessor } from '../processor.js';
import { AbortOptions, MaybePromise } from '@mithic/commons';

/** {@link EventProcessor} that persists events using an {@link ObjectWriter}. */
export class EventPersister<Event, SrcEvent = Event>
  extends EventProcessor<SrcEvent>
{
  public constructor(
    /** {@link EventSubscription} to consume. */
    subscription: EventSubscription<SrcEvent>,
    /** Event store writer to use. */
    writer: ObjectWriter<Event>,
    /** Function to transform incoming events for storage. */
    transform: EventTransformer<SrcEvent, Event> = identity,
  ) {
    const consumer = async (event: SrcEvent) => {
      const targetEvent = await transform(event);
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
