const NS_HEAD = 'H';
const NS_VALUE = 'V';
const NS_EVENT = 'E';
const NS_FIELD = 'F';
const TERMINAL = '\udbff\udfff';
const FIELD_NAME_REGEX = /:F:(.+(?=:E:)|.+(?!:E:)$)/;

/** Namespace separator for keys. */
export const KEY_NS_SEPARATOR = ':';

/** Gets the key for a field value. */
export function getFieldValueKey(mapName: string, field?: string, eventKey?: string): string {
  return `${NS_VALUE}${KEY_NS_SEPARATOR}${KEY_NS_SEPARATOR}${mapName}${
    field ? `${KEY_NS_SEPARATOR}${NS_FIELD}${KEY_NS_SEPARATOR}${field}` : ''
  }${eventKey ? `${KEY_NS_SEPARATOR}${NS_EVENT}${KEY_NS_SEPARATOR}${eventKey}` : ''}`;
}

/** Gets the index key for head events. */
export function getHeadIndexKey(mapName: string, field?: string, eventKey?: string): string {
  return `${NS_HEAD}${KEY_NS_SEPARATOR}${KEY_NS_SEPARATOR}${mapName}${
    field ? `${KEY_NS_SEPARATOR}${NS_FIELD}${KEY_NS_SEPARATOR}${field}` : ''
  }${eventKey ? `${KEY_NS_SEPARATOR}${NS_EVENT}${KEY_NS_SEPARATOR}${eventKey}` : ''}`;
}

/** Gets the index key for an event. */
export function getEventIndexKey(eventKey: string, field?: string): string {
  return `${NS_EVENT}${KEY_NS_SEPARATOR}${KEY_NS_SEPARATOR}${eventKey}${
    field ? `${KEY_NS_SEPARATOR}${NS_FIELD}${KEY_NS_SEPARATOR}${field}` : ''
  }`;
}

/** Gets the range end key that represents the end of a key prefix. */
export function getPrefixEndKey(key: string): string {
  return `${key}${TERMINAL}`;
}

/** Gets the field name from a key. */
export function getFieldNameFromKey(key: string): string {
  return key.match(FIELD_NAME_REGEX)?.[1] || '';
}
