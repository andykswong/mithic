import { MaybeAsyncIterator, MaybePromise, maybeAsync } from '@mithic/commons';
import { MessageDispatcher } from './bus.js';

/** A command call, which is a (maybe async) function that can have side effects. */
export interface Command<Args extends unknown[] = unknown[]> {
  (...args: Args): MaybePromise<void>
}

/** A record whose values are {@link Command}s. */
export type Commands<E extends MessageTypeMap = MessageTypeMap> = {
  [K in MessageName<E>]: Command<E[K][0]>;
}

/** A (maybe async) function that creates a message (command or event). */
export interface MessageCreator<Args extends unknown[] = unknown[], Msg = unknown> {
  (...args: Args): MaybePromise<Msg>
}

/** A record whose values are {@link MessageCreator}s. */
export type MessageCreators<E extends MessageTypeMap = MessageTypeMap> = {
  [K in MessageName<E>]: MessageCreator<E[K][0], E[K][1]>;
}

/** A message generator, which is a function that returns a message iterable. */
export interface MessageGenerator<Args extends unknown[] = unknown[], Msg = unknown> {
  (...args: Args): MaybeAsyncIterator<Msg>
}

/** A record whose values are {@link MessageGenerator}s. */
export type MessageGenerators<E extends MessageTypeMap = MessageTypeMap> = {
  [K in MessageName<E>]: MessageGenerator<E[K][0], E[K][1]>;
}

/** {@link MessageCreator} or {@link MessageGenerator} type name to arguments and return types map. */
export type MessageTypeMap<K extends string = string, Msg = unknown> = Record<K, [unknown[], Msg]>;

/** {@link MessageCreator} or {@link MessageGenerator} name type from {@link MessageTypeMap}. */
export type MessageName<E extends MessageTypeMap> = E extends MessageTypeMap<infer T> ? T : never;

/** Binds an {@link MessageCreator} to an {@link MessageDispatcher} and returns a {@link Command}. */
export function bindMessageCreator<Args extends unknown[], Msg>(
  creator: MessageCreator<Args, Msg>,
  dispatcher: MessageDispatcher<Msg>
): Command<Args> {
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return (...args: Args) => MaybePromise.map(creator(...args), dispatch);
}

/** Binds {@link MessageCreator}s to an {@link MessageDispatcher} and returns a {@link Commands}. */
export function bindMessageCreators<Msg, M extends MessageTypeMap<string, Msg>>(
  creators: MessageCreators<M>,
  dispatcher: MessageDispatcher<Msg>
): Commands<M> {
  const commands = {} as Commands<M>;
  for (const key in creators) {
    commands[key as MessageName<M>] =
      bindMessageCreator(creators[key as MessageName<M>], dispatcher);
  }
  return commands;
}

/** Binds an {@link MessageGenerator} to an {@link MessageDispatcher} and returns a {@link Command}. */
export function bindMessageGenerator<Args extends unknown[], Msg>(
  generator: MessageGenerator<Args, Msg>,
  dispatcher: MessageDispatcher<Msg>
): Command<Args> {
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return maybeAsync(function* (...args: Args) {
    const iter = generator(...args);
    for (let result: IteratorResult<Msg> = yield iter.next(); !result.done; result = yield iter.next()) {
      yield dispatch(yield result.value);
    }
  });
}

/** Binds {@link MessageGenerator}s to an {@link MessageDispatcher} and returns a {@link Commands}. */
export function bindMessageGenerators<Msg, M extends MessageTypeMap<string, Msg>>(
  generators: MessageGenerators<M>,
  dispatcher: MessageDispatcher<Msg>
): Commands<M> {
  const commands = {} as Commands<M>;
  for (const key in generators) {
    commands[key as MessageName<M>] =
      bindMessageGenerator(generators[key as MessageName<M>], dispatcher);
  }
  return commands;
}
