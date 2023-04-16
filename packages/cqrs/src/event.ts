import { AbortOptions, MaybePromise } from '@mithic/commons';

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
export type EventConsumer<Event> = (event: Event) => MaybePromise<void>;

/** Function to transform and/or filter a source event into target event type. */
export type EventTransformer<SrcEvent, Event = SrcEvent> = (event: SrcEvent) => MaybePromise<Event | undefined>;

/** Function to unsubscribe event consumer added by {@link EventSubscription#subscribe}. */
export type Unsubscribe = (options?: AbortOptions) => MaybePromise<void>;
