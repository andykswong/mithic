import { symMacro } from '../symbol.ts';
import { AsyncValue, Env, MacroValue, ObjValue } from '../types.ts';
import { isFunction, isObj, isString } from '../utils.ts';

/** Try to deference symbol. */
export function deref<Required extends boolean>(
  ref: string, env: Env, required: Required = false as Required
): Required extends true ? AsyncValue : AsyncValue | undefined {
  const value = env.get(ref);
  if (required && value === void 0) { throw new ReferenceError(`${ref} is not defined`); }
  return value as AsyncValue;
}

export function quasiquote(expr: AsyncValue, env: Env): AsyncValue {
  if (Array.isArray(expr)) {
    if (expr.length === 0) { return expr; }
    if (expr[0] === ',') { return expr[1]; }
    const result: AsyncValue[] = ['...'];
    for (let i = 0; i < expr.length; ++i) {
      const elt = expr[i];
      if (Array.isArray(elt) && elt[0] === ',@') {
        result.push(elt[1]);
      } else {
        const qelt = quasiquote(elt, env);
        const last = result[result.length - 1];
        if (Array.isArray(last) && last[0] === '[]') {
          last.push(qelt);
        } else {
          result.push(['[]', qelt]);
        }
      }
    }
    return result;
  } else if (isObj(expr)) {
    return Object.entries(expr).reduce(
      (obj, [key, value]) => ((obj[key] = quasiquote(value, env)), obj),
      Object.create(null) as ObjValue
    );
  } else if (isString(expr)) {
    return ['\'', expr];  // quote strings
  }
  return expr;
}

export function macroExpand(expr: AsyncValue, env: Env, times = Infinity): AsyncValue {
  let macro: MacroValue | null = null;
  for (let i = 0; i < times; ++i) {
    if (!Array.isArray(expr) || !expr.length || (macro = getIfMacro(expr, env)) === null) { break; }
    expr = macro.apply(env, expr.slice(1));
  }
  return expr;
}

function getIfMacro(expr: AsyncValue[], env: Env): MacroValue | null {
  if (!isString(expr[0])) { return null; }
  const f = env.get(expr[0]) ?? null;
  if (!isFunction(f) || !f[symMacro]) { return null; }
  return f as MacroValue;
}
