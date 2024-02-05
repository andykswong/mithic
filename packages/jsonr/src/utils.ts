import { AsyncValue, FnValue, JSONType, ObjValue } from './types.ts';

export function assertString(arg: AsyncValue, msg?: string): asserts arg is string {
  if (typeof arg !== 'string') { throw new SyntaxError(msg ?? `Unexpected ${typeof arg}, expect string`); }
}

export function assertArray(arg: AsyncValue, msg?: string): asserts arg is AsyncValue[] {
  if (!Array.isArray(arg)) { throw new SyntaxError(msg ?? `Unexpected ${typeof arg}, expect array`); }
}

export function assertStrings(args: AsyncValue, msg?: string): asserts args is string[] {
  if (!Array.isArray(args)) { throw new SyntaxError(msg ?? `Unexpected ${typeof args}, expect string[]`); }
  for (const arg of args) { assertString(arg); }
}

export function assertFunction(arg: AsyncValue, name = arg): asserts arg is FnValue {
  if (typeof arg !== 'function') { throw new TypeError(`${name} is not a function`); }
}

/** Returns if value is a number. */
export function isNumber(arg: AsyncValue): arg is number {
  return typeof arg === 'number';
}

/** Returns if value is a string. */
export function isString(arg: AsyncValue): arg is string {
  return typeof arg === 'string';
}

/** Returns if value is a function. */
export function isFunction(arg: AsyncValue): arg is FnValue {
  return typeof arg === 'function';
}

/** returns if given value is an object. */
export function isObj(arg: AsyncValue): arg is ObjValue {
  return (arg !== null && typeof arg === 'object' && Object.getPrototypeOf(arg) === null);
}

/** Converts a native object into object. */
export function obj<T = JSONType>(o: Record<string, T> = {}): Record<string, T> {
  return Object.entries(o).reduce(
    (o, [k, v]) => (o[k] = v, o),
    Object.create(null)
  );
}
