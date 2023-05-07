import { RangeQueryOptions } from '@mithic/collections';
import { ContentId, concatBuffers } from '@mithic/commons';
import { Event, EventMetadata } from '../event.js';

const ENCODER = new TextEncoder();
const INT64_BUFFER = new Uint8Array(8);
const INT64_VIEW = new DataView(INT64_BUFFER.buffer);

const KEY_SEPARATOR = ENCODER.encode('::');
const KEY_TERMINAL = new Uint8Array([255]);
const KEY_HEAD = ENCODER.encode('h');
const KEY_TIME = ENCODER.encode('t');
const KEY_ROOT_TIME = ENCODER.encode('r');
const KEY_TYPE_TIME = ENCODER.encode('e');
const KEY_ROOT_TYPE_TIME = ENCODER.encode('re');

/** Default regex for splitting event types. */
export const DEFAULT_EVENT_TYPE_SEPARATOR = /[._#$\-/]+/g;

/** Gets all event store index keys for an event. */
export function getEventIndexKeys<Id extends ContentId, E extends Event<unknown, EventMetadata<Id>>>(
  key: Id, event: E, headOnly = false, typeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR
): Uint8Array[] {
  const keyBytes = key.bytes;
  const root = event.meta.root?.bytes ?? keyBytes;
  const time = event.meta.createdAt;
  const typePrefixes = getEventTypePrefixes(event.type, typeSeparator);

  const keys = [];
  for (const head of (headOnly ? [true] : [true, false])) {
    keys.push(
      getEventIndexKey(head, keyBytes, void 0, void 0, time),
      getEventIndexKey(head, keyBytes, void 0, root, time),
    );
    for (const type of typePrefixes) {
      keys.push(
        getEventIndexKey(head, keyBytes, type, void 0, time),
        getEventIndexKey(head, keyBytes, type, root, time),
      );
    }
  }
  return keys;
}

/** Gets the range query options for an event store index. */
export function getEventIndexRangeQueryOptions<Id extends ContentId>(
  sinceTime: number, type?: string, root?: Id, headOnly = false
): RangeQueryOptions<Uint8Array> {
  const eventType = type ? ENCODER.encode(type) : void 0;
  const rootBytes = root?.bytes;
  return {
    gt: concatBuffers(getEventIndexKey(headOnly, void 0, eventType, rootBytes, sinceTime + 1), KEY_SEPARATOR),
    lt: concatBuffers(getEventIndexKey(headOnly, void 0, eventType, rootBytes), KEY_SEPARATOR, KEY_TERMINAL),
  };
}

/** Gets the event store index key for an event. */
export function getEventIndexKey(
  head: boolean, key?: Uint8Array, type?: Uint8Array, root?: Uint8Array, time?: number
): Uint8Array {
  const keyParts = head ? [KEY_HEAD] : [];
  keyParts.push(
    root && type ? KEY_ROOT_TYPE_TIME :
      root ? KEY_ROOT_TIME :
        type ? KEY_TYPE_TIME : KEY_TIME
  );
  root && keyParts.push(KEY_SEPARATOR, root);
  type && keyParts.push(KEY_SEPARATOR, type);
  (time !== void 0) && keyParts.push(KEY_SEPARATOR, serializeNumber(time));
  key && keyParts.push(KEY_SEPARATOR, key);
  return concatBuffers(...keyParts);
}

/** Gets all prefixes for an event type. */
export function getEventTypePrefixes(type: string, separator: RegExp): Uint8Array[] {
  const matches = type.matchAll(separator);
  const prefixes = [ENCODER.encode(type)];
  for (const match of matches) {
    if (match.index) {
      prefixes.push(ENCODER.encode(type.substring(0, match.index)));
    }
  }
  return prefixes;
}

/** Serializes a number to a int64 big endian byte array. */
export function serializeNumber(value: number): Uint8Array {
  INT64_VIEW.setBigInt64(0, BigInt(value), false);
  return INT64_BUFFER;
}
