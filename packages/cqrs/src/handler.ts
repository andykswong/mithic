import { AbortOptions, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';
import { StandardCommand, StandardEvent } from './event.js';

/** Command handler function. */
export interface CommandHandler<State = undefined, Command = StandardCommand, Event = StandardEvent, Opts = object> {
  (state: State, command: Command, options?: AbortOptions & Opts): MaybePromise<Event | undefined>;
}

/** Reducer function of messages to state. */
export interface MessageReduceHandler<State = unknown, Msg = unknown, Opts = object> {
  (state: State, message: Msg, options?: AbortOptions & Opts): MaybePromise<State>;
}

/** Function that transform input message to output message. */
export interface MessageTransformHandler<SrcMsg, OutMsg = SrcMsg, Opts = object> {
  (msg: SrcMsg, options?: AbortOptions & Opts): MaybePromise<OutMsg | undefined>;
}

/** Saga function that generates output messages from input message. */
export interface MessageSagaHandler<SrcMsg, OutMsg = SrcMsg, Opts = object> {
  (msg: SrcMsg, options?: AbortOptions & Opts): MaybeAsyncIterableIterator<OutMsg>;
}

/** An interface for writing objects to storage. */
export interface ObjectWriter<K = unknown, V = unknown, Opts = object> {
  /** Puts given value and returns its key. */
  put(value: V, options?: AbortOptions & Opts): MaybePromise<K>;
}
