import { Error } from '@mithic/commons';

/** Error that can occur when using the messaging interface. */
export class MessagingError extends Error<MessagingErrorPayload, MessagingErrorType> {
  public constructor(payload: MessagingErrorPayload) {
    super(payload.val || payload.tag, { name: MessagingError.name, payload });
  }
}

/** Error which may be raised by functions in this package. */
export type MessagingErrorPayload = {
  tag: typeof MessagingErrorType.Unauthorized | typeof MessagingErrorType.Unsupported | typeof MessagingErrorType.Timeout,
  val?: never,
} | {
  tag: typeof MessagingErrorType.Connection | typeof MessagingErrorType.Abandoned | typeof MessagingErrorType.Other,
  val: string,
};

/** Error that can occur when using the messaging interface. */
export const MessagingErrorType = {
  /** The operation is not authorized. */
  Unauthorized: 'unauthorized',
  /** The operation is supported. */
  Unsupported: 'unsupported',
  /** The operation timed out. */
  Timeout: 'timeout',
  /** An error occurred with the connection. */
  Connection: 'connection',
  /** Work on the message was abandoned for the given reason. */
  Abandoned: 'abandoned',
  /** A catch all for other types of errors. */
  Other: 'other',
} as const;

export type MessagingErrorType = typeof MessagingErrorType[keyof typeof MessagingErrorType];

/** A message with a binary payload and additional information. */
export interface Message {
  /** The topic/subject/channel this message was received or should be sent on. */
  readonly topic: string,
  /** The content type describing the format of the data in the message. */
  readonly contentType?: string,
  /** An opaque blob of data. */
  readonly data: Uint8Array,
  /** Metadata (also called headers or attributes in some systems) attached to the message. */
  readonly metadata: [key: string, value: string][],
}

export {
  isMessage, getMessageMetadata, setMessageMetadata, RequestReplyHelper, type RequestReplyHelperOptions
} from './utils/index.ts';

/** Common {@link Message} metadata field names. */
export const MessageMetadata = {
  /** ID of the sender. */
  From: 'from',
  /** Topic to use to reply a request. */
  ReplyTopic: 'X-Reply-Topic',
  /** ID for a request. */
  RequestId: 'X-Request-ID',
  /** The request ID that a reply message corresponds to. */
  CorrelationId: 'X-Correlation-ID',
} as const;

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

/** Incoming message handler for guests. */
export interface IncomingHandler {
  /**
   * Handles message in one of the subscribed channels.
   * @throws {@link MessagingError}
   */
  handle(msg: Message): void;
}

/** Fully-qualified name for incoming handler. */
export const IncomingHandlerFQN = 'mithic:messaging/incoming-handler@0.2.0';

/** Messaging guest module. */
export interface MessagingGuest {
  /** Incoming message handler. */
  [IncomingHandlerFQN]?: IncomingHandler;
}
