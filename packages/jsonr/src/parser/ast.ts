import { symAsync, symFn, symFnArgs, symFnBody, symMacro } from '../symbol.ts';
import { JSONType, AsyncValue, ObjValue, Parser } from '../types.ts';
import { isFunction, isObj, isString } from '../utils.ts';

/** metael JSON-based AST Parser. */
export class JsonAstParser implements Parser {
  public parse(expr: string): JSONType {
    return JSON.parse(expr, reviver);
  }

  public print(expr: AsyncValue): string {
    return JSON.stringify(expr, replacer);
  }
}

function reviver(_: string, value: JSONType): AsyncValue {
  if (isString(value) && value.length > 1) { // handle quoted/unquoted strings
    const first = value.charAt(0);
    if (first === '\'' || first === ',') {
      return [first, value.substring(1)];
    }
  }
  if (Array.isArray(value)) { return value; }
  if (value && (typeof value === 'object')) { // remove object prototype
    return Object.entries(value).reduce(
      (obj, [key, value]) => ((obj[key] = value), obj),
      Object.create(null) as ObjValue
    );
  }
  return value;
}

function replacer(_: string, value: AsyncValue): AsyncValue {
  if (isFunction(value)) {
    if (!value[symFn]) { return value.name || 'fn#anonymous'; } // native function
    return [
      value[symMacro] ? "macro" : value[symAsync] ? "async" : "fn",
      value[symFnArgs] ?? [],
      value[symFnBody] ?? null
    ];
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && (value[0] === '\'' || value[0] === ',') && isString(value[1])) {
      return value[0] + value[1]; // handle quoted/unquoted strings
    }
    return value;
  }
  if (value && (typeof value === 'object') && !isObj(value)) {
    return {}; // unknown object
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return [value < 0 ? '-' : '+', `${Math.abs(value)}`]; // encode NaN, +-Infinity which are not a valid json
  }
  return value;
}
