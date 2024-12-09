import { type Element, ValueType, type Value } from '../types.ts';

const DECODER = new TextDecoder();
const INVALID_TAG_CHARS = /[^a-zA-Z0-9-]/g;
const INVALID_ATTR_CHARS = /[^a-zA-Z0-9_:.$-]/g;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const QUOTE = /"/g;
const FRAGMENT = 'fragment';

export function attrName(name: string): string {
  return name.replace(INVALID_ATTR_CHARS, '').toLowerCase();
}

export function eventName(name: string): string | undefined {
  if (name.startsWith('on')) {
    return name.substring(2).toLowerCase();
  }
}

export function tagName(name?: string): string {
  return name ? name.replace(INVALID_TAG_CHARS, '').toLowerCase() : FRAGMENT;
}

export function isFragment(tag?: string): boolean {
  return !tag || tag === FRAGMENT;
}

export function isNumeric(value: Value): boolean {
  switch (value.tag) {
    case ValueType.Int32:
    case ValueType.Int64:
    case ValueType.Uint32:
    case ValueType.Uint64:
    case ValueType.Float:
    case ValueType.Double:
      return true;
  }
  return false;
}

export function isVoidTag(name: string): boolean {
  return VOID_TAGS.has(name);
}

export function encodeValue(value: string): string {
  return value.replace(QUOTE, '&quot;');
}

export function valueAsString(value: Value): string {
  switch (value.tag) {
    case ValueType.Binary:
      return DECODER.decode(value.val);
    case ValueType.String:
      return value.val;
    case ValueType.Boolean:
    case ValueType.Int32:
    case ValueType.Int64:
    case ValueType.Uint32:
    case ValueType.Uint64:
    case ValueType.Float:
    case ValueType.Double:
      return `${value.val}`;
  }
  return '';
}

export function elementEntry(element: Element) {
  return [element.id, element] as const;
}

export function filterObject<T extends object>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if ((obj as Record<string, unknown>)[key] === undefined) {
      delete (obj as Record<string, unknown>)[key];
    }
  }
  return obj;
}
