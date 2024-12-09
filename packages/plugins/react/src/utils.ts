import { type Element } from '@mithic/dom';

const FRAGMENT = 'fragment';

export function elementEntry(element: Element) {
  return [element.id, element] as const;
}

export function tagName(tag?: string): string {
  return tag || FRAGMENT;
}

export function isFragment(tag?: string): boolean {
  return !tag || tag === FRAGMENT;
}

export function isEventHandler(key: string): boolean {
  return key.length > 2 && key[0] === 'o' && key[1] === 'n' && key[3] === key[3].toUpperCase();
}

export function isObject(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && !!obj;
}

export function filterObject<T extends object>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if ((obj as Record<string, unknown>)[key] === undefined) {
      delete (obj as Record<string, unknown>)[key];
    }
  }
  return obj;
}
