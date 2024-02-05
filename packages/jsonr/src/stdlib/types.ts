import { symFn } from '../symbol.ts';
import { AsyncValue, Env, FnValue, ObjValue } from '../types.ts';
import { assertFunction, isFunction, isObj, isString } from '../utils.ts';

/** Creates an array from elements. */
export function array(...vals: AsyncValue[]): AsyncValue[] {
  return vals;
}

/** Creates an object from entries. */
export function object(...entries: AsyncValue[]): ObjValue {
  const result = Object.create(null);
  for (let i = 0; i < entries.length; i += 2) {
    result[entries[i] as string] = entries[i + 1] ?? null;
  }
  return result;
}

/** Stringify given value, while sanitizing native objects and functions. */
export function string(val: AsyncValue): string {
  if (isFunction(val) && !val[symFn]) { return val.name || 'fn#anonymous'; }
  if (val && !Array.isArray(val) && !isObj(val) && typeof val === 'object') { return '{}'; }
  return `${val ?? null}`;
}

/** Returns given value as boolean */
export function boolean(a: AsyncValue): boolean {
  return !!a;
}

/** Converts a string to an integer number. */
export const parseInt = global.parseInt as FnValue;

/** Converts a string to a number. */
export const parseFloat = global.parseFloat as FnValue;

/** Merges arrays or objects. */
export function concat(val: AsyncValue, ...vals: AsyncValue[]): AsyncValue {
  if (!vals.length) { return val; }
  if (isObj(val)) { return Object.assign(Object.create(null), val, ...vals); }
  return ([] as AsyncValue[]).concat(val, ...vals);
}

/** Returns a subarray or substring. */
export function slice(val: AsyncValue, start: AsyncValue, end: AsyncValue): AsyncValue {
  if (Array.isArray(val)) { return val.slice(start as number, end as number); }
  if (isString(val)) { return val.slice(start as number, end as number); }
  return val;
}

/** Maps an array or value. */
export function map(this: Env, fn: AsyncValue, val: AsyncValue): AsyncValue {
  assertFunction(fn, 'arg0 of map');
  return Array.isArray(val) ? val.map(fn, this) : fn.call(this, val ?? null, 0, null);
}

/** Returns length of an array, string or object. */
export function length(iterable: AsyncValue): number {
  if (Array.isArray(iterable) || isString(iterable)) { return iterable.length; }
  if (isObj(iterable)) { return Object.keys(iterable).length; }
  return iterable === null ? 0 : 1;
}

/** Returns keys of an array, string or object. */
export function keys(iterable: AsyncValue): (string | number)[] {
  if (Array.isArray(iterable)) { return [...iterable.keys()]; }
  if (isString(iterable)) { return Array.from({ length: iterable.length }, (_, k) => k); }
  if (isObj(iterable)) { return Object.keys(iterable); }
  return [];
}

/** Returns values of an array, string or object. */
export function values(iterable: AsyncValue): AsyncValue[] {
  if (Array.isArray(iterable)) { return iterable; }
  if (isString(iterable)) { return [...iterable]; }
  if (isObj(iterable)) { return Object.values(iterable); }
  return [];
}

/** Returns entries of an array, string or object. */
export function entries(iterable: AsyncValue): [string | number, AsyncValue][] {
  if (Array.isArray(iterable)) { return [...iterable.entries()]; }
  if (isString(iterable)) { return [...[...iterable].entries()]; }
  if (isObj(iterable)) { return Object.entries(iterable); }
  return [];
}
