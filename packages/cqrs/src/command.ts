import { MaybeAsyncIterator, MaybePromise, maybeAsync } from '@mithic/commons';
import { EventDispatcher } from './event.js';

/** A command, which is a (maybe async) function that can have side effects. */
export interface Command<Args extends unknown[] = unknown[]> {
  (...args: Args): MaybePromise<void>
}

/** A record whose values are {@link Command}s. */
export type Commands<E extends EventTypeMap = EventTypeMap> = {
  [K in EventName<E>]: Command<E[K][0]>;
}

/** An event creator, which is a (maybe async) function that creates an event. */
export interface EventCreator<Args extends unknown[] = unknown[], Event = unknown> {
  (...args: Args): MaybePromise<Event>
}

/** A record whose values are {@link EventCreator}s. */
export type EventCreators<E extends EventTypeMap = EventTypeMap> = {
  [K in EventName<E>]: EventCreator<E[K][0], E[K][1]>;
}

/** An event generator, which is a function that returns an event iterable. */
export interface EventGenerator<Args extends unknown[] = unknown[], Event = unknown> {
  (...args: Args): MaybeAsyncIterator<Event>
}

/** A record whose values are {@link EventGenerator}s. */
export type EventGenerators<E extends EventTypeMap = EventTypeMap> = {
  [K in EventName<E>]: EventGenerator<E[K][0], E[K][1]>;
}

/** {@link EventCreator} or {@link EventGenerator} type name to arguments and return types map. */
export type EventTypeMap<K extends string = string, Event = unknown> = Record<K, [unknown[], Event]>;

/** {@link EventCreator} or {@link EventGenerator} name type from {@link EventTypeMap}. */
export type EventName<E extends EventTypeMap> = E extends EventTypeMap<infer T> ? T : never;

/** Binds an {@link EventCreator} to an {@link EventDispatcher} and returns a {@link Command}. */
export function bindEventCreator<Args extends unknown[], Event>(
  eventCreator: EventCreator<Args, Event>,
  dispatcher: EventDispatcher<Event>
): Command<Args> {
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return (...args: Args) => MaybePromise.map(eventCreator(...args), dispatch);
}

/** Binds {@link EventCreator}s to an {@link EventDispatcher} and returns a {@link Commands}. */
export function bindEventCreators<E, M extends EventTypeMap<string, E>>(
  eventCreators: EventCreators<M>,
  dispatcher: EventDispatcher<E>
): Commands<M> {
  const commands = {} as Commands<M>;
  for (const key in eventCreators) {
    commands[key as EventName<M>] =
      bindEventCreator(eventCreators[key as EventName<M>], dispatcher);
  }
  return commands;
}

/** Binds an {@link EventGenerator} to an {@link EventDispatcher} and returns a {@link Command}. */
export function bindEventGenerator<Args extends unknown[], Event>(
  eventGenerator: EventGenerator<Args, Event>,
  dispatcher: EventDispatcher<Event>
): Command<Args> {
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return maybeAsync(function* (...args: Args) {
    const iter = eventGenerator(...args);
    for (let result: IteratorResult<Event> = yield iter.next(); !result.done; result = yield iter.next()) {
      yield dispatch(yield result.value);
    }
  });
}

/** Binds {@link EventGenerator}s to an {@link EventDispatcher} and returns a {@link Commands}. */
export function bindEventGenerators<E, M extends EventTypeMap<string, E>>(
  eventGenerators: EventGenerators<M>,
  dispatcher: EventDispatcher<E>
): Commands<M> {
  const commands = {} as Commands<M>;
  for (const key in eventGenerators) {
    commands[key as EventName<M>] =
      bindEventGenerator(eventGenerators[key as EventName<M>], dispatcher);
  }
  return commands;
}
