import { symAsync, symEnv, symFn, symFnArgs, symFnBody, symMacro } from '../symbol.ts';
import { AsyncValue, Env, FnValue } from '../types.ts';
import { isString, assertStrings } from '../utils.ts';
import { ControlFlag } from './control.ts';
import { evalExpr } from './eval.ts';

export function evalFn(
  expr: AsyncValue[], env: Env, isMacro = false, isAsync = false
): FnValue {
  let fn: string | null = null, args: AsyncValue, body: AsyncValue;
  if (expr.length < 3) { throw new SyntaxError(`Unexpected token 'fn'`) }
  if (isString(expr[1])) {
    [, fn, args, body] = expr;
  } else {
    [, args, body] = expr;
  }
  assertStrings(args);
  const f = createFn(args, body, env, isMacro, isAsync);
  return fn ? env.setOwn(fn, f) : f;
}

export function createFn(
  args: string[], body: AsyncValue, env: Env | null = null,
  isMacro = false, isAsync = false
): FnValue {
  const f: FnValue = function (this: Env, ...vals: AsyncValue[]): AsyncValue {
    const env = createFnEnv(f, this);
    assignArgs(f[symFnArgs] || [], vals, env);
    return evalExpr(f[symFnBody], env, ControlFlag.TailCall);
  };
  if (isMacro) {
    f[symMacro] = true as const;
  } else if (isAsync) {
    f[symAsync] = true as const;
  }
  f[symFn] = true as const;
  f[symEnv] = env;
  f[symFnArgs] = args;
  f[symFnBody] = body;
  f.toString = () => JSON.stringify([
    isMacro ? "macro" : isAsync ? "async" : "fn",
    args,
    body
  ]);
  return f;
}

export function createFnEnv(f: FnValue, env: Env): Env {
  const newEnv = (f[symEnv] ?? env.global).push();
  newEnv.fn = true;
  newEnv.async = !!f[symAsync];
  return newEnv;
}

export function assignArgs(args: string[], vals: AsyncValue[], env: Env): void {
  for (let i = 0; i < args.length - 1; ++i) {
    env.setOwn(args[i], vals[i] ?? null);
  }
  const lastArg = args[args.length - 1];
  if (!lastArg) { return }
  if (lastArg.startsWith('...')) {
    env.setOwn(lastArg.substring(3), vals.slice(args.length - 1));
  } else {
    env.setOwn(lastArg, vals[args.length - 1] ?? null);
  }
}
