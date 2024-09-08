import { type Codec } from '@mithic/commons';
import { decode } from 'cbor-x/decode';
import { encode } from 'cbor-x/encode';
import { type Message, type MessagingErrorPayload, type PeerId, type RequestOptions } from '../types.ts';

/** Messaging service operation types. */
export const MessagingOp = {
  Response: 1,
  Message: 2,
  Subscribe: 3,
  Subscriber: 4
} as const;

export type MessagingOp = typeof MessagingOp[keyof typeof MessagingOp];

/** Messaging service control message. */
export type MessagingMessage = {
  op: MessagingOp,
  seq: number,
} & ({
  op: typeof MessagingOp.Response,
  msgs?: Message[],
  peers?: PeerId[],
  error?: MessagingErrorPayload,
} | ({
  op: typeof MessagingOp.Message,
  msg: Message,
  replyTo?: Message,
} & Partial<RequestOptions>) | {
  op: typeof MessagingOp.Subscribe,
  topics: string[],
} | {
  op: typeof MessagingOp.Subscriber,
  topic: string,
});

export const MessagingMessage: Codec<MessagingMessage> = {
  /** Encodes a messaging control message using CBOR. */
  encode(message: MessagingMessage): Uint8Array {
    return encode(message);
  },

  /** Decodes messaging control message from CBOR. */
  decode(message: Uint8Array): MessagingMessage | undefined {
    return decode(message);
  }
};
