import { type Message } from '../types.ts';

/** Checks if an object is a valid {@link Message}. */
export function isMessage(obj: unknown): obj is Message {
  const msg = obj as Message;
  return (
    typeof msg?.topic === 'string' &&
    (msg.contentType === undefined || typeof msg.contentType === 'string') &&
    msg.data instanceof Uint8Array &&
    isMessageMetadata(msg.metadata)
  );
}

function isMessageMetadata(obj: unknown): obj is Message['metadata'] {
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

/** Helper function to get a message metadata value, if exists. */
export function getMessageMetadata(message: Message, key: string): string | undefined {
  return message.metadata.find((entry) => isKey(key, entry))?.[1];
}

function isKey(key: string, entry: [key: string, value: string]): boolean {
  return entry[0].toLowerCase() === key.toLowerCase();
}

/** Helper function to set a message metadata value. */
export function setMessageMetadata(message: Message, field: string, value: string, override = false): string {
  const entry = message.metadata.find((entry) => isKey(field, entry));
  if (entry) {
    if (override) { entry[1] = value; }
    return entry[1];
  }
  message.metadata.push([field, value]);
  return value;
}
