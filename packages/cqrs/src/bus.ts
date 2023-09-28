import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A message bus service. */
export interface MessageBus<SrcMsg, OutMsg = SrcMsg> extends MessageDispatcher<SrcMsg>, MessageSubscription<OutMsg> {
}

/** A message dispatcher service. */
export interface MessageDispatcher<Msg> {
  /** Dispatches a message. */
  dispatch(message: Msg, options?: AbortOptions): MaybePromise<void>;
}

/** A message subscription service. */
export interface MessageSubscription<Msg> {
  /** Subscribes consumer to new messages and returns a handle to unsubscribe. */
  subscribe(consumer: MessageConsumer<Msg>, options?: AbortOptions): MaybePromise<Unsubscribe>;
}

/** Consumer function of messages. */
export type MessageConsumer<Msg> = (msg: Msg, options?: AbortOptions) => MaybePromise<void>;

/** Function to unsubscribe consumers added by {@link MessageSubscription#subscribe}. */
export type Unsubscribe = (options?: AbortOptions) => MaybePromise<void>;
