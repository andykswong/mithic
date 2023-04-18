import { EventEmitter as NodeEventEmitter } from 'events';
import { MaybePromise, SyncOrAsyncGenerator } from './async/index.js';

/** Type-safe event emitter interface. */
export interface TypedEventEmitter<E extends EventTypeMap> extends EventSource<E> {
  /**
   * Calls each of the listeners registered for the given event type,
   * in the order they were registered, passing the supplied arguments to each.
   * Returns true if the event had listeners, false otherwise.
   */
  emit<K extends EventType<E>>(type: K, ...args: E[K]): boolean;
}

/** Type-safe event source interface. */
export interface EventSource<E extends EventTypeMap> {
  /** Adds the listener function to the end of the listeners array for the given event type. */
  addListener<K extends EventType<E>>(type: K, listener: EventHandler<E[K]>): this;

  /** Removes the specified listener from the listener array for the given event type. */
  removeListener<K extends EventType<E>>(type: K, listener: EventHandler<E[K]>): this;

  /** Removes all listeners, or those of the given event type. */
  removeAllListeners<K extends EventType<E>>(type?: K): this;
}

/** Event type to argument type map. */
export type EventTypeMap<K extends string = string> = Record<K, unknown[]>;

/** Event name type from {@link EventTypeMap}. */
export type EventType<E> = E extends EventTypeMap<infer T> ? T : never;

/** Type-safe event handler function. */
export type EventHandler<Args extends unknown[] = unknown[], R = void> = (...args: Args) => MaybePromise<R>;

/**
 * {@link TypedEventEmitter} implementation. Most useful as a base class to enable a class to emit type-safe events.
 * If not extending, EventEmitter from node:events can be casted to {@link TypedEventEmitter} and be used directly.
 */
export class EventEmitter<E extends EventTypeMap = Record<string, unknown[]>> implements TypedEventEmitter<E> {
  public constructor(
    protected emitter: NodeEventEmitter = new NodeEventEmitter()
  ) { }

  public addListener<K extends EventType<E>>(type: K, listener: EventHandler<E[K]>): this {
    this.emitter.addListener(type, listener as (...args: unknown[]) => void);
    return this;
  }

  public removeListener<K extends EventType<E>>(type: K, listener: EventHandler<E[K]>): this {
    this.emitter.removeListener(type, listener as (...args: unknown[]) => void);
    return this;
  }

  public removeAllListeners<K extends EventType<E>>(type?: K): this {
    this.emitter.removeAllListeners(type);
    return this;
  }

  public emit<K extends EventType<E>>(type: K, ...args: E[K]): boolean {
    return this.emitter.emit(type, ...args);
  }
}

/** Creates a consumer function from a coroutine. Useful for defining event handlers. */
export function consumer<V = unknown>(
  coroutine: () => SyncOrAsyncGenerator<unknown, unknown, V>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): EventHandler<[V], any> {
  const generator = coroutine();
  let execution = generator.next(); // execute until the first yield
  return (input) =>
    MaybePromise.map(
      execution,
      () => (execution = generator.next(input))
    );
}
