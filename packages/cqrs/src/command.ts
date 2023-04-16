import { MaybePromise, mapAsync } from '@mithic/commons';
import { EventDispatcher } from './event.js';

/** An event creator, which is a (maybe async) function that creates an event. */
export interface EventCreator<Args extends unknown[] = unknown[], Event = unknown> {
  (...args: Args): MaybePromise<Event>
}

/** A record whose values are {@link EventCreator}s. */
export type EventCreators<E extends EventCreatorTypeMap = EventCreatorTypeMap> = {
  [K in EventCreatorName<E>]: EventCreator<E[K][0], E[K][1]>;
}

/** A command, which is a (maybe async) function that can have side effects. */
export interface Command<Args extends unknown[] = unknown[]> {
  (...args: Args): MaybePromise<void>
}

/** A record whose values are {@link Command}s. */
export type Commands<E extends EventCreatorTypeMap = EventCreatorTypeMap> = {
  [K in EventCreatorName<E>]: Command<E[K][0]>;
}

/** {@link EventCreator} type name to arguments and return types map. */
export type EventCreatorTypeMap<K extends string = string, Event = unknown> = Record<K, [unknown[], Event]>;

/** {@link EventCreator} name type from {@link EventCreatorTypeMap}. */
export type EventCreatorName<E extends EventCreatorTypeMap> = E extends EventCreatorTypeMap<infer T> ? T : never;

/** {@link EventCreator} result event type from {@link EventCreatorTypeMap}. */
export type EventCreatorResult<E extends EventCreatorTypeMap> =
  E extends EventCreatorTypeMap<string, infer T> ? T : never;

/** Binds an {@link EventCreator} to an {@link EventDispatcher} and returns a {@link Command}. */
export function bindEventCreator<Args extends unknown[], Event>(
  eventCreator: EventCreator<Args, Event>,
  dispatcher: EventDispatcher<Event>
): Command<Args> {
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return (...args: Args) => mapAsync(eventCreator(...args), dispatch);
}

/** Binds {@link EventCreator}s to an {@link EventDispatcher} and returns a {@link Commands}. */
export function bindEventCreators<E extends EventCreatorTypeMap>(
  eventCreators: EventCreators<E>,
  dispatcher: EventDispatcher<EventCreatorResult<E>>
): Commands<E> {
  const commands = {} as Commands<E>;
  for (const key in eventCreators) {
    commands[key as EventCreatorName<E>] =
      bindEventCreator(eventCreators[key as EventCreatorName<E>], dispatcher);
  }
  return commands;
}
