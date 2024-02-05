import { symMacro } from '../symbol.ts';
import { AsyncValue } from '../types.ts';
import { isFunction, isNumber, isObj, isString } from '../utils.ts';
import { length } from './types.ts';

/** Returns if value is empty. */
export function isEmpty(iterable: AsyncValue): boolean {
  return !length(iterable);
}

/** Returns if value is null. */
export function isNull(val: AsyncValue): boolean {
  return val === null;
}

/** Returns if value is true or false. */
export function isBoolean(val: AsyncValue): boolean {
  return val === true || val === false;
}

/** Returns if value is an array. */
export function isArray(val: AsyncValue): boolean {
  return Array.isArray(val);
}

/** Returns if value is a macro function. */
export function isMacro(val: AsyncValue): boolean {
  return isFunction(val) && !!val[symMacro];
}

/** Returns if value is NaN. */
export function isNaN(val: AsyncValue): boolean {
  return Number.isNaN(val);
}

/** Returns if value is a finite number. */
export function isFinite(val: AsyncValue): boolean {
  return Number.isFinite(val);
}

export { isFunction, isNumber, isObj as isObject, isString };
