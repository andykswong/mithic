import { MaybeAsyncIterator, MaybePromise, maybeAsync } from '@mithic/commons';
import { MessageDispatcher } from './bus.js';

/** A (maybe async) function that creates a message (command or event). */
export interface MessageCreator<Msg = unknown, Args extends unknown[] = unknown[]> {
  (...args: Args): MaybePromise<Msg>
}

/** A record whose values are {@link MessageCreator}s. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageCreators<Msg = unknown, K extends string = string, Args extends unknown[] = any[]>
  = Record<K, MessageCreator<Msg, Args>>;

/** A message generator, which is a function that returns a message iterable. */
export interface MessageGenerator<Msg = unknown, Args extends unknown[] = unknown[]> {
  (...args: Args): MaybeAsyncIterator<Msg>
}

/** A record whose values are {@link MessageGenerator}s. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageGenerators<Msg = unknown, K extends string = string, Args extends any[] = any[]>
  = Record<K, MessageGenerator<Msg, Args>>;

/** {@link MessageCreator} or {@link MessageGenerator} name type from {@link MessageTypeMap}. */
export type MessageName<M extends MessageCreators | MessageGenerators> =
  M extends MessageCreators<unknown, infer K> ? K :
  M extends MessageGenerators<unknown, infer K> ? K :
  never;

/** A command call, which is a (maybe async) function that can have side effects. */
export interface Command<Args extends unknown[] = unknown[]> {
  (...args: Args): MaybePromise<void>
}

/** A record whose values are {@link Command}s. */
export type Commands<M extends MessageCreators | MessageGenerators> = {
  [K in MessageName<M>]: Command<Parameters<M[K]>>;
}

/** Binds an {@link MessageCreator} to an {@link MessageDispatcher} and returns a {@link Command}. */
export function bindMessageCreator<Msg, Args extends unknown[]>(
  creator: MessageCreator<Msg, Args>,
  dispatcher: MessageDispatcher<Msg>
): Command<Args> {
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  return (...args: Args) => MaybePromise.map(creator(...args), dispatch);
}

/** Binds {@link MessageCreator}s to an {@link MessageDispatcher} and returns a {@link Commands}. */
export function bindMessageCreators<Msg, M extends MessageCreators<Msg>>(
  creators: M,
  dispatcher: MessageDispatcher<Msg>
): Commands<M> {
  const commands = {} as Commands<M>;
  for (const key in creators) {
    commands[key as unknown as MessageName<M>] = bindMessageCreator(creators[key], dispatcher);
  }
  return commands;
}

/** Binds an {@link MessageGenerator} to an {@link MessageDispatcher} and returns a {@link Command}. */
export function bindMessageGenerator<Msg, Args extends unknown[]>(
  generator: MessageGenerator<Msg, Args>,
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
export function bindMessageGenerators<Msg, M extends MessageGenerators<Msg>>(
  generators: M,
  dispatcher: MessageDispatcher<Msg>
): Commands<M> {
  const commands = {} as Commands<M>;
  for (const key in generators) {
    commands[key as unknown as MessageName<M>] = bindMessageGenerator(generators[key], dispatcher);
  }
  return commands;
}
