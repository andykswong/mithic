import { Error, type MaybePromise } from '@mithic/commons';
import type { Message } from './message.ts';

export {
  isMessageRecord, MessageMetadata, RequestReplyAdapter, type RequestReplyAdapterOptions
} from './utils/index.ts';

/** Error that can occur when using the messaging interface. */
export class MessagingError extends Error<MessagingErrorPayload, MessagingErrorType> {
  public constructor(payload: MessagingErrorPayload) {
    super(payload.val || payload.tag, { name: MessagingError.name, payload });
  }
}

/** Error which may be raised by functions in this package. */
export type MessagingErrorPayload = {
  tag: typeof MessagingErrorType.Timeout,
  val?: never,
} | {
  tag: typeof MessagingErrorType.Connection | typeof MessagingErrorType.PermissionDenied | typeof MessagingErrorType.Other,
  val: string,
};

/** Error that can occur when using the messaging interface. */
export const MessagingErrorType = {
  /** The operation timed out. */
  Timeout: 'timeout',
  /** An error occurred with the connection. */
  Connection: 'connection',
  /** A permission error occurred. */
  PermissionDenied: 'permission-denied',
  /** A catch all for other types of errors. */
  Other: 'other',
} as const;

export type MessagingErrorType = typeof MessagingErrorType[keyof typeof MessagingErrorType];

/** Options for a request. */
export interface RequestOptions {
  /** The maximum amount of time to wait for a response. */
  timeoutMs?: number;
  /** The maximum number of replies to expect before returning. */
  expectedReplies?: number;
}

declare const __peerId: unique symbol;

/** Peer ID type. */
export type PeerId = string & { [__peerId]: never };

/** Message handler. */
export interface MessageHandler {
  /**
   * Handles message in one of the subscribed channels.
   * @throws {@link MessagingError}
   */
  handle(msg: Message): MaybePromise<void>;
}

/** Fully-qualified name for incoming handler. */
export const IncomingHandlerFQN = 'mithic:messaging/incoming-handler@0.3.0';

/** Messaging guest component. */
export interface MessagingGuest {
  /** Incoming message handler. */
  [IncomingHandlerFQN]?: MessageHandler;
}
