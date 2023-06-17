const NS_HEAD = 'H';
const NS_VALUE = 'V';
const NS_EVENT = 'E';
const NS_FIELD = 'F';
const TERMINAL = '\udbff\udfff';
const FIELD_NAME_REGEX = /:F:(.+(?=:E:)|.+(?!:E:)$)/;

const ASCII64_DIGIT = '+/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz~';

/** Namespace separator for keys. */
export const KEY_NS_SEPARATOR = ':';

/** Gets the key for a field value. */
export function getFieldValueKey(mapKey: string, field?: string, eventKey?: string): string {
  return `${NS_VALUE}${KEY_NS_SEPARATOR}${KEY_NS_SEPARATOR}${mapKey}${
    field ? `${KEY_NS_SEPARATOR}${NS_FIELD}${KEY_NS_SEPARATOR}${field}` : ''
  }${eventKey ? `${KEY_NS_SEPARATOR}${NS_EVENT}${KEY_NS_SEPARATOR}${eventKey}` : ''}`;
}

/** Gets the index key for head events. */
export function getHeadIndexKey(mapKey: string, field?: string, eventKey?: string): string {
  return `${NS_HEAD}${KEY_NS_SEPARATOR}${KEY_NS_SEPARATOR}${mapKey}${
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

/** Generates random fractional index strings from a range of (start, end). */
export function * getFractionalIndices(
  start: string | undefined, end: string | undefined, count: number,
  rand: () => number = Math.random, minRandBits = 48
): IterableIterator<string> {
  const endBytes = [...(end || ASCII64_DIGIT[64])].map(char => {
    const index = ASCII64_DIGIT.indexOf(char);
    return index >= 0 && index < 64 ? index : 64;
  });
  const startBytes = [...(start || ASCII64_DIGIT[0])].map(char => {
    const index = ASCII64_DIGIT.indexOf(char);
    return index >= 0 && index < 64 ? index : 0;
  });

  for (let i = 0, start = startBytes; i < count; ++i) {
    const result: number[] = [];
    for (
      let j = 0, randBits = 0, equalStartEnd = true, resultEqualStart = true;
      resultEqualStart || Math.round(randBits) < minRandBits;
      ++j
    ) {
      const rangeStart = start[j] ?? 0;
      const rangeEnd: number = equalStartEnd ? (endBytes[j] ?? 64) : 64;
      equalStartEnd = equalStartEnd && rangeStart === rangeEnd;
      const next = equalStartEnd ? rangeStart : Math.floor(rand() * (rangeEnd - rangeStart) + rangeStart);
      result.push(next);
      resultEqualStart = resultEqualStart && next === rangeStart;
      if (!equalStartEnd) {
        randBits += Math.log2(rangeEnd - rangeStart);
      }
    }
    yield fractionalIndexToString(result);
    start = result;
  }
}

/** Converts a fractional index array to string. */
export function fractionalIndexToString(index: number[]): string {
  return index.map(byte => ASCII64_DIGIT[byte] || ASCII64_DIGIT[0]).join('');
}
