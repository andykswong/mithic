import { maybeAsync } from '@mithic/commons';
import { symCtrl, symFn, symFnArgs, symFnBody } from '../symbol.ts';
import { AsyncValue, Env, FnValue, ObjValue, Value } from '../types.ts';
import { assertArray, assertFunction, assertString, isObj, isString } from '../utils.ts';
import { ControlFlag, ControlValue, isControl, isLoopControl, isReturn, unwrapReturn } from './control.ts';
import { assignArgs, createFnEnv, evalFn } from './fn.ts';
import { deref, macroExpand, quasiquote } from './meta.ts';

/** Evaluates an expression. */
export const evalExpr = maybeAsync(coEvalExpr);

type FnForm = (expr: AsyncValue[], env: Env, flags?: ControlFlag) => AsyncValue;
const fnForm: Record<string, FnForm> = {
  fn: (expr, env) => evalFn(expr, env),
  async: (expr, env) => evalFn(expr, env, false, true),
  macro: (expr, env) => evalFn(expr, env, true),
  macroexpand: (expr, env) => macroExpand(expr[1], env, +(expr[2] as number) || Infinity),
  '\'': (expr) => expr[1] ?? null,
  throw: (expr) => { throw expr[1] ?? null; },
  break: evalBreakContinue.bind(null, ControlFlag.Break),
  continue: evalBreakContinue.bind(null, ControlFlag.Continue),
};

type CoEvalForm = (expr: AsyncValue[], env: Env, flags?: ControlFlag) =>
  Generator<AsyncValue, AsyncValue | ControlValue, Value>;
const coroutineForm: Record<string, CoEvalForm> = {
  await: coEvalAwait,
  return: coEvalReturn,
  // TODO: add yield points to for/while to support abort signals
  for: coEvalFor,
  while: coEvalWhile,
  const: (expr, env) => coEvalAssign(expr, env, true, true),
  let: (expr, env) => coEvalAssign(expr, env, true),
  '=': (expr, env) => coEvalAssign(expr, env),
  '@': coEvalDeref,
  '&&': coEvalAndOr,
  '||': coEvalAndOr,
  '??': coEvalNullCoalescing,
};

const specialForms = new Set([...Object.keys(fnForm), ...Object.keys(coroutineForm),
  '`', '{}', ';', 'if', 'try', 'catch' // inline forms
]);

/** Coroutine to evaluate an expression. */
export function* coEvalExpr(
  expr: AsyncValue | undefined, env: Env, flags = ControlFlag.None
): Generator<AsyncValue, AsyncValue | ControlValue, Value> {
  loop: for (; ;) {
    // 1. null
    if (expr === null || expr === void 0) { return null; }

    // 2. function call
    if (Array.isArray(expr)) {
      // expand macros
      expr = macroExpand(expr, env);
      if (!Array.isArray(expr)) { continue loop; }
      if (expr.length === 0) { return expr; }

      // evaluate special forms
      if (isString(expr[0])) {
        if (expr[0] in fnForm) { return fnForm[expr[0]](expr, env, flags); }
        if (expr[0] in coroutineForm) { return yield* coroutineForm[expr[0]](expr, env, flags); }

        switch (expr[0]) { // inline forms below needs to be added to `specialForms` set
          case '`': expr = quasiquote(expr[1] ?? null, env);
            continue loop;
          case '{}': env = env.push();
          // eslint-disable-next-line no-fallthrough
          case ';': env.fn && (flags |= ControlFlag.Return);
            for (let i = 1; i < expr.length - 1; ++i) {
              const result = yield* coEvalExpr(expr[i], env, flags & ~ControlFlag.TailCall);
              if (isReturn(result)) { return unwrapReturn(result, flags); }
              if (isLoopControl(result)) { return result; }
            }
            expr = expr[expr.length - 1];
            continue loop;
          case 'if': expr = ((yield* coEvalExpr(expr[1], env)) ? expr[2] : expr[3]) ?? null;
            continue loop;
          case 'try': try {
            return yield* coEvalExpr(expr[1], env, flags & ~ControlFlag.TailCall);
          } catch (e) {
            expr = inlineEvalCatch(expr[2], env = env.push(), e);
            continue loop;
          }
        }
      }

      // inline function call
      const [fn, args] = yield* coParseCall(expr, env);
      if (!fn[symFn]) { return fn.apply(env.global, args) ?? null; }
      assignArgs(fn[symFnArgs] || [], args, env = createFnEnv(fn, env));
      expr = fn[symFnBody];
      flags |= ControlFlag.TailCall;
      continue loop;
    }

    // 3. obj
    if (isObj(expr)) { return yield* coEvalObj(expr, env); }

    // 4. symbol
    if (isString(expr)) {
      if (specialForms.has(expr)) { throw new SyntaxError(`Unexpected token '${expr}'`); }
      return deref(expr, env, true);
    }

    // 5. primitive or native or control type: return unchanged
    return expr;
  }
}

export function* coEvalAwait(expr: AsyncValue<Value>[], env: Env): Generator<AsyncValue, AsyncValue, Value> {
  if (!env.async) { throw new SyntaxError('await is only valid in async scope'); }
  return (yield (yield* coEvalExpr(expr[1], env))) ?? null;
}

export function* coEvalDeref(expr: AsyncValue<Value>[], env: Env): Generator<AsyncValue, AsyncValue, Value> {
  const ref = yield* coEvalExpr(expr[1], env);
  assertString(ref);
  return deref(ref, env, true);
}

export function* coEvalReturn(
  expr: AsyncValue<Value>[], env: Env, flags = ControlFlag.None
): Generator<AsyncValue, AsyncValue | ControlValue, Value> {
  if (!(flags & ControlFlag.Return)) { throw new SyntaxError('Illegal return statement'); }
  const value = yield* coEvalExpr(expr[1], env);
  return (flags & ControlFlag.TailCall) ? value :
    { [symCtrl]: ControlFlag.Return, value } satisfies ControlValue;
}

export function* coEvalObj(obj: ObjValue, env: Env): Generator<AsyncValue, ObjValue, Value> {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(obj)) {
    result[key] = yield* coEvalExpr(value, env);
  }
  return result;
}

export function* coEvalAssign(
  expr: AsyncValue[], env: Env, define = false, readOnly = false
): Generator<AsyncValue, AsyncValue, Value> {
  let result: AsyncValue = null;
  for (let i = 1; i < expr.length; i += 2) {
    const value = yield* coEvalExpr(expr[i + 1] ?? null, env);
    setValue(expr[i], value, env, define, readOnly);
    result = value;
  }
  return result;
}

function setValue(lhs: AsyncValue, value: AsyncValue, env: Env, define = false, readOnly = false) {
  // TODO: support obj destructuring
  if (Array.isArray(lhs)) {
    const iter = (value as AsyncValue[])?.[Symbol.iterator]?.();
    if (!iter) { throw new TypeError(`${value} is not iterable`); }
    for (let j = 0, v = iter.next(); j < lhs.length && !v.done; ++j, v = iter.next()) {
      let lval = lhs[j], rval = v.value;
      if (j === lhs.length - 1 && isString(lval) && lval.startsWith('...')) {
        lval = lval.substring(3);
        rval = [rval];
        for (; !v.done; v = iter.next()) { rval.push(v.value); }
      }
      setValue(lval, rval, env, define, readOnly);
    }
    return;
  }

  assertString(lhs);
  if (define) {
    env.setOwn(lhs, value, readOnly);
  } else {
    if (env.get(lhs) === void 0) { throw new ReferenceError(`${lhs} is not defined`); }
    env.set(lhs, value);
  }
}

export function* coParseCall(
  expr: AsyncValue[], env: Env
): Generator<AsyncValue, [fn: FnValue, args: AsyncValue[]], Value> {
  const isApply = expr[0] === 'apply';

  const f = yield* coEvalExpr(expr[isApply ? 1 : 0], env);
  assertFunction(f, expr[0]);

  let args: AsyncValue[] = [];
  if (isApply) {
    const argsArg = yield* coEvalExpr(expr[2], env);
    assertArray(argsArg);
    args = argsArg;
  } else {
    for (let i = 1; i < expr.length; ++i) {
      args.push(yield* coEvalExpr(expr[i], env));
    }
  }
  return [f, args];
}

export function* coEvalAndOr(expr: AsyncValue<Value>[], env: Env): Generator<AsyncValue, AsyncValue, Value> {
  if (expr.length === 1) { return null; }
  const isAnd = expr[0] === '&&';
  let result: AsyncValue = isAnd ? true : false;
  for (let i = 1; !(isAnd ? !result : result) && i < expr.length; ++i) {
    const rhs = yield* coEvalExpr(expr[i], env);
    result = isAnd ? result && rhs : result || rhs;
  }
  return result;
}

export function* coEvalNullCoalescing(expr: AsyncValue<Value>[], env: Env): Generator<AsyncValue, AsyncValue, Value> {
  let result: AsyncValue = null;
  for (let i = 1; result === null && i < expr.length; ++i) {
    const rhs = yield* coEvalExpr(expr[i], env);
    result = result ?? rhs;
  }
  return result;
}

export function* coEvalFor(expr: AsyncValue[], env: Env): Generator<AsyncValue, AsyncValue, Value> {
  const flags = ControlFlag.Break | ControlFlag.Continue | (env.fn ? ControlFlag.Return : ControlFlag.None);
  const name = expr[1];
  assertString(name);
  const innerEnv = env.push();
  let result = null;
  for (const val of (yield* coEvalExpr(expr[2], env)) as Iterable<AsyncValue>) {
    innerEnv.setOwn(name, val);
    result = yield* coEvalExpr(expr[3], innerEnv, flags);
    if (isControl(result)) {
      switch (result[symCtrl]) {
        case ControlFlag.Return: return unwrapReturn(result, flags);
        case ControlFlag.Break: return null;
        case ControlFlag.Continue: result = null;
      }
    }
  }
  return result;
}

export function* coEvalWhile(expr: AsyncValue[], env: Env): Generator<AsyncValue, AsyncValue, Value> {
  const flags = ControlFlag.Break | ControlFlag.Continue | (env.fn ? ControlFlag.Return : ControlFlag.None);
  let result = null;
  while ((yield* coEvalExpr(expr[1], env))) {
    result = yield* coEvalExpr(expr[2], env, flags);
    if (isControl(result)) {
      switch (result[symCtrl]) {
        case ControlFlag.Return: return unwrapReturn(result, flags);
        case ControlFlag.Break: return null;
        case ControlFlag.Continue: result = null;
      }
    }
  }
  return result;
}

export function inlineEvalCatch(catchExpr: AsyncValue, env: Env, err: unknown): AsyncValue {
  if (!Array.isArray(catchExpr) || catchExpr[0] !== 'catch') { throw new SyntaxError('Missing catch after try'); }
  if (catchExpr.length < 3) { return catchExpr[1] ?? null; }
  assertString(catchExpr[1]);
  env.setOwn(catchExpr[1], err as AsyncValue);
  return catchExpr[2] ?? null;
}

export function evalBreakContinue(
  type: ControlFlag, expr: AsyncValue<Value>[], _: Env, flags = ControlFlag.None
): ControlValue {
  if (!(flags & type) || (expr[1] && !isString(expr[1]))) {
    throw new SyntaxError(`Illegal ${type & ControlFlag.Continue ? 'continue' : 'break'} statement`);
  }
  return { [symCtrl]: type, value: expr[1] } satisfies ControlValue;
}
