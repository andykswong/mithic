import type { MessageRecord } from '../message.ts';

/** Common Message metadata field names. */
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

/** Checks if an object is a valid {@link MessageRecord}. */
export function isMessageRecord(obj: unknown): obj is MessageRecord {
  const msg = obj as MessageRecord;
  return (
    (msg.topic === undefined || typeof msg?.topic === 'string') &&
    (msg.contentType === undefined || typeof msg.contentType === 'string') &&
    msg.data instanceof Uint8Array &&
    isMessageMetadata(msg.metadata)
  );
}

function isMessageMetadata(obj: unknown): obj is MessageRecord['metadata'] {
  if (!Array.isArray(obj)) {
    return false;
  }
  for (const entry of obj) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      return false;
    }
  }
  return true;
}
