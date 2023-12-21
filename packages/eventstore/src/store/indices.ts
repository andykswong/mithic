import { RangeQueryOptions } from '@mithic/collections';
import { DEFAULT_EVENT_TYPE_SEPARATOR, DEFAULT_KEY_ENCODER } from '../defaults.js';
import { EventMeta } from '../event.js';

const KEY_SEPARATOR = '::';
const KEY_TERMINAL = '\udbff\udfff';
const KEY_HEAD = 'H';
const KEY_TIME = 'T';
const KEY_ROOT_TIME = 'R';
const KEY_TYPE_TIME = 'E';
const KEY_ROOT_TYPE_TIME = 'RE';

/** Gets all event store index keys for an event. */
export function getEventIndexKeys<K, E extends EventMeta<K>>(
  key: K, eventMeta: E, headOnly = false, encodeKey: (key: K) => string = DEFAULT_KEY_ENCODER,
  typeSeparator = DEFAULT_EVENT_TYPE_SEPARATOR
): string[] {
  const keyBytes = encodeKey(key);
  const root = eventMeta?.root !== void 0 ? encodeKey(eventMeta.root) : keyBytes;
  const time = eventMeta?.time;
  const typePrefixes = getEventTypePrefixes(eventMeta.type, typeSeparator);

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
export function getEventIndexRangeQueryOptions<K>(
  sinceTime: number, type?: string, root?: K, headOnly = false,
  encodeKey: (key: K) => string = DEFAULT_KEY_ENCODER,
): RangeQueryOptions<string> {
  const rootEncoded = root !== void 0 ? encodeKey(root) : void 0;
  return {
    lower: getEventIndexKey(headOnly, void 0, type, rootEncoded, sinceTime + 1) + KEY_SEPARATOR,
    lowerOpen: true,
    upper: `${getEventIndexKey(headOnly, void 0, type, rootEncoded)}${KEY_SEPARATOR}${KEY_TERMINAL}`,
  };
}

/** Gets the event store index key for an event. */
export function getEventIndexKey(
  head: boolean, key?: string, type?: string, root?: string, time?: number
): string {
  const keyParts = head ? [KEY_HEAD] : [];
  keyParts.push(
    root && type ? KEY_ROOT_TYPE_TIME :
      root ? KEY_ROOT_TIME :
        type ? KEY_TYPE_TIME : KEY_TIME
  );
  root && keyParts.push(KEY_SEPARATOR, root);
  type && keyParts.push(KEY_SEPARATOR, type);
  (time !== void 0) && keyParts.push(KEY_SEPARATOR, `${Math.round(+time).toString(16).padStart(16, '0')}`);
  key && keyParts.push(KEY_SEPARATOR, key);
  return keyParts.join('');
}

/** Gets all prefixes for an event type. */
export function getEventTypePrefixes(type: string, separator: RegExp): string[] {
  const matches = type.matchAll(separator);
  const prefixes = [type];
  for (const match of matches) {
    if (match.index) {
      prefixes.push(type.substring(0, match.index));
    }
  }
  return prefixes;
}
