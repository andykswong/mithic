import { RangeQueryOptions } from '@mithic/collections';
import { concatBuffers } from '@mithic/commons';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER, TEXT_ENCODER } from '../../defaults.js';
import { Event, EventMetadata } from '../../event.js';

const INT64_BUFFER = new Uint8Array(8);
const INT64_VIEW = new DataView(INT64_BUFFER.buffer);

// tokens are chosen to be 3-bytes wide to align with base64 encoding
const KEY_SEPARATOR = TEXT_ENCODER.encode(':::');
const KEY_TERMINAL = new Uint8Array([255, 255, 255]);
const KEY_HEAD = TEXT_ENCODER.encode('h');
const KEY_ALL = TEXT_ENCODER.encode('a');
const KEY_TIME = TEXT_ENCODER.encode('t_');
const KEY_ROOT_TIME = TEXT_ENCODER.encode('r_');
const KEY_TYPE_TIME = TEXT_ENCODER.encode('e_');
const KEY_ROOT_TYPE_TIME = TEXT_ENCODER.encode('re');

/** Gets all event store index keys for an event. */
export function getEventIndexKeys<Id, E extends Event<unknown, EventMetadata<Id>>>(
  key: Id, event: E, headOnly = false, encodeKey: (key: Id) => Uint8Array = DEFAULT_KEY_ENCODER,
  typeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR
): Uint8Array[] {
  const keyBytes = encodeKey(key);
  const root = event.meta.root !== void 0 ? encodeKey(event.meta.root) : keyBytes;
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
export function getEventIndexRangeQueryOptions<Id>(
  sinceTime: number, type?: string, root?: Id, headOnly = false,
  encodeKey: (key: Id) => Uint8Array = DEFAULT_KEY_ENCODER
): RangeQueryOptions<Uint8Array> {
  const eventType = type ? TEXT_ENCODER.encode(type) : void 0;
  const rootBytes = root !== void 0 ? encodeKey(root) : void 0;
  return {
    gt: concatBuffers(getEventIndexKey(headOnly, void 0, eventType, rootBytes, sinceTime + 1), KEY_SEPARATOR),
    lt: concatBuffers(getEventIndexKey(headOnly, void 0, eventType, rootBytes), KEY_SEPARATOR, KEY_TERMINAL),
  };
}

/** Gets the event store index key for an event. */
export function getEventIndexKey(
  head: boolean, key?: Uint8Array, type?: Uint8Array, root?: Uint8Array, time?: number
): Uint8Array {
  const keyParts = head ? [KEY_HEAD] : [KEY_ALL];
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
  const prefixes = [TEXT_ENCODER.encode(type)];
  for (const match of matches) {
    if (match.index) {
      prefixes.push(TEXT_ENCODER.encode(type.substring(0, match.index)));
    }
  }
  return prefixes;
}

/** Serializes a number to a int64 big endian byte array. */
export function serializeNumber(value: number): Uint8Array {
  INT64_VIEW.setBigInt64(0, BigInt(value), false);
  return INT64_BUFFER;
}
