import { AsyncValue, Env, Evaluator, FnValue, JSONType } from '../types.ts';
import { evalExpr } from './eval.ts';
import { createFn } from './fn.ts';

/** metael interpreter. */
export class Interpreter implements Evaluator {
  public compile<Args extends unknown[] = AsyncValue[]>(expr: JSONType, args: string[] = []): FnValue<Args> {
    return createFn(args, expr) as FnValue<Args>;
  }

  public eval(expr: JSONType, env: Env): AsyncValue {
    return evalExpr(expr, env);
  }
}
