import { AsyncValue, Env, FnValue, ObjValue } from '../types.ts';
import { isNumber, isObj, isString } from '../utils.ts';

export function plus(a: AsyncValue, ...args: AsyncValue[]): number | string {
  if (!args.length) { return +(a as number); }
  let result = a as number;
  for (const arg of args) { result += arg as number; }
  return result;
}

export function minus(a: AsyncValue, b?: AsyncValue): number {
  if (b === void 0) { return -(a as number); }
  return (a as number) - (b as number);
}

export function times(a: AsyncValue, b: AsyncValue): number {
  return (a as number) * (b as number);
}

export function div(a: AsyncValue, b: AsyncValue): number {
  return (a as number) / (b as number);
}

export function pow(a: AsyncValue, b: AsyncValue): number {
  return (a as number) ** (b as number);
}

export function rem(a: AsyncValue, b: AsyncValue): number {
  return (a as number) % (b as number);
}

export function xor(a: AsyncValue, b: AsyncValue): number {
  return (a as number) ^ (b as number);
}

export function and(a: AsyncValue, b: AsyncValue): number {
  return (a as number) & (b as number);
}

export function or(a: AsyncValue, b: AsyncValue): number {
  return (a as number) | (b as number);
}

export function inv(a: AsyncValue): number {
  return ~(a as number);
}

export function not(a: AsyncValue): boolean {
  return !a;
}

export function equals(a: AsyncValue, b: AsyncValue): boolean {
  return a === b;
}

export function notEquals(a: AsyncValue, b: AsyncValue): boolean {
  return a !== b;
}

export function lessThan(a: AsyncValue, b: AsyncValue): boolean {
  return (a as number) < (b as number);
}

export function lessEquals(a: AsyncValue, b: AsyncValue): boolean {
  return (a as number) <= (b as number);
}

export function greaterThan(a: AsyncValue, b: AsyncValue): boolean {
  return (a as number) > (b as number);
}

export function greaterEquals(a: AsyncValue, b: AsyncValue): boolean {
  return (a as number) >= (b as number);
}

export function del(target: AsyncValue, key: AsyncValue): boolean {
  if (!isObj(target)) { return false; }
  return (delete (target as ObjValue)[key as string]);
}

export function contains(target: AsyncValue, key: AsyncValue): boolean {
  return ((key as string) ?? '') in (target as ObjValue);
}

export function get(val: AsyncValue, ...paths: AsyncValue[]): AsyncValue {
  let result = val;
  for (const arg of paths) {
    if (Array.isArray(result) || isObj(result)) {
      result = (result as ObjValue)[arg as string] as AsyncValue;
    } else if (isString(result)) {
      result = result.charAt(+(arg as number));
    } else {
      return null;
    }
  }
  return result ?? null;
}

export function set(target: AsyncValue, key: AsyncValue, val: AsyncValue): AsyncValue {
  if ((Array.isArray(target) && isNumber(key)) || isObj(target)) {
    return ((target as ObjValue)[key as string] = val);
  }
  return null;
}

export function call(this: Env, target: AsyncValue, key: AsyncValue, ...args: AsyncValue[]) {
  if ((Array.isArray(target) && isNumber(key)) || isObj(target)) {
    return ((target as ObjValue)[key as string] as FnValue)?.apply(this, args) ?? null;
  }
  return null;
}
