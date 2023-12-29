import { MaybePromise, MaybePromiseFn, SyncOrAsyncGenerator } from './async/index.js';

/** Typed Event. */
export interface TypedEvent<T extends string = string> extends Event {
  type: T;
}

/** Typed CustomEvent. */
export interface TypedCustomEvent<T extends string = string, V = unknown> extends CustomEvent<V>, TypedEvent<T> {
  type: T;
}

/** Type-safe event handler. */
export type TypedEventHandler<E extends TypedEvent, R = unknown> = TypedEventHandlerFn<E, R> | TypedEventHandlerObject<E, R>;

/** Type-safe event handler function. */
export type TypedEventHandlerFn<E extends TypedEvent, R = unknown> = MaybePromiseFn<[E], R>;

/** Type-safe event handler object. */
export interface TypedEventHandlerObject<E extends TypedEvent, R = unknown> {
  handleEvent: TypedEventHandlerFn<E, R>;
}

/** The union of all possible event types from a TypedEvent tuple. */
export type EventTypes<Events> = Events extends TypedEvent<infer T>[] ? T : string;

/** Picks event of given type from a TypedEvent tuple. */
export type EventsOfType<Events, T extends string> = Extract<Events[keyof Events], TypedEvent<T>>;

/** Type-safe event dispatcher. */
export interface EventDispatcher<Events extends TypedEvent[]> extends EventSource<Events> {
  /**
   * Dispatches the `event` to the list of handlers for `event.type`.
   * @returns `false` if event is cancelled; `true` otherwise.
   */
  dispatchEvent(event: Events[keyof Events]): boolean;
}

/** Type-safe event source. */
export interface EventSource<Events extends TypedEvent[]> {
  /** Registers an event handler of a specific event type. */
  addEventListener<K extends EventTypes<Events>>(type: K, listener: TypedEventHandler<EventsOfType<Events, K>>): void;

  /** Removes an event listener. */
  removeEventListener<K extends EventTypes<Events>>(type: K, listener: TypedEventHandler<EventsOfType<Events, K>>): void;
}

/** Type-safe EventTarget. */
export class TypedEventTarget<Events extends TypedEvent[]>
  extends EventTarget implements EventDispatcher<Events>
{
  public override addEventListener<K extends EventTypes<Events>>(
    type: K, listener: TypedEventHandler<EventsOfType<Events, K>> | null
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject);
  }

  public override removeEventListener<K extends EventTypes<Events>>(
    type: K, listener: TypedEventHandler<EventsOfType<Events, K>> | null
  ): void {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject);
  }

  public override dispatchEvent<K extends EventTypes<Events>>(event: EventsOfType<Events, K>): boolean {
    return super.dispatchEvent(event);
  }
}

/** Creates a {@link TypedCustomEvent}. */
export function createEvent<T extends string, V>(type: T, detail: V): TypedCustomEvent<T, V> {
  return new CustomEvent(type, { detail }) as TypedCustomEvent<T, V>;
}

/** Creates a consumer function from a coroutine. Useful for defining event handlers. */
export function consumer<E = unknown>(
  coroutine: () => SyncOrAsyncGenerator<unknown, unknown, E>,
): MaybePromiseFn<[E], IteratorResult<unknown>> {
  const generator = coroutine();
  let execution = generator.next(); // execute until the first yield
  return (input) =>
    MaybePromise.map(
      execution,
      () => (execution = generator.next(input))
    );
}
