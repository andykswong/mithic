import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageValidationError } from './error.ts';

/**
 * A generalized message bus service interface,
 * which can represent publish/subscribe service, message queue or any producer-consumer model.
 */
export interface MessageBus<OutMsg, InMsg = OutMsg, SubHandlerOpts = object>
  extends MessageDispatcher<OutMsg>, MessageSubscription<InMsg, SubHandlerOpts> { }

/** A message dispatcher service. */
export interface MessageDispatcher<Msg> {
  /** Dispatches a message. */
  dispatch(message: Msg, options?: MessageOptions): MaybePromise<void>;
}

/** A message subscription service. */
export interface MessageSubscription<Msg, HandlerOpts = object> {
  /** Subscribes to new messages and returns a handle to unsubscribe. */
  subscribe(
    handler: MessageHandler<Msg, HandlerOpts>,
    options?: SubscribeOptions<Msg, HandlerOpts>
  ): MaybePromise<Unsubscribe>;
}

/** Options for . */
export interface SubscribeOptions<Msg, Opts = object> extends MessageOptions {
  /** Message validator for the topic. */
  validator?: MessageValidator<Msg, Opts>;
}

/** Function to unsubscribe handlers added by {@link MessageSubscription#subscribe}. */
export type Unsubscribe = (options?: AbortOptions) => MaybePromise<void>;

/**
 * Message handler function.
 * Depending on message bus implementation, throwing an exception may cause the message to be retried.
 */
export type MessageHandler<Msg, Opts = object> = (message: Msg, options?: MessageOptions & Opts) => MaybePromise<void>;

/** Message validator function. */
export type MessageValidator<Msg, Opts = object> =
  (message: Msg, options?: MessageOptions & Opts) => MaybePromise<MessageValidationError | undefined>;

/** Messaging context options. */
export interface MessageOptions extends AbortOptions {
  /** The message's topic. */
  readonly topic?: string;
}
