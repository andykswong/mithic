import { AbortOptions, EventHandler, MaybePromise } from '@mithic/commons';

/** An event bus. */
export interface EventBus<Event> extends EventDispatcher<Event>, EventSubscription<Event> {
}

/** An event dispatcher. */
export interface EventDispatcher<Event> {
  /** Dispatches an event. */
  dispatch(event: Event, options?: AbortOptions): MaybePromise<void>;
}

/** An event subscription service. */
export interface EventSubscription<Event> {
  /** Subscribes consumer to new events and returns a handle to unsubscribe. */
  subscribe(consumer: EventConsumer<Event>, options?: AbortOptions): MaybePromise<Unsubscribe>;
}

/** Consumer function of events. */
export type EventConsumer<Event> = EventHandler<[Event], void>;

/** Function to transform and/or filter a source event into target event type. */
export type EventTransformer<SrcEvent, Event = SrcEvent> = EventHandler<[SrcEvent], Event | undefined>;

/** Function to unsubscribe event consumer added by {@link EventSubscription#subscribe}. */
export type Unsubscribe = (options?: AbortOptions) => MaybePromise<void>;
