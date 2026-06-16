/**
 * The jq engine public API: parse a program once, then run it against inputs.
 *
 * {@link compile} returns a {@link CompiledFilter} you can apply to many inputs;
 * {@link run} is the one-shot convenience used by the CLI. The interpreter is
 * synchronous and generator-based — `run` collects all outputs into an array.
 */
import { parse } from './parser.ts';
import type { Node } from './ast.ts';
import { Env, evalNode } from './interp.ts';
import type { Context } from './interp.ts';

export { JQError } from './interp.ts';
export { toJSON, typeOf } from './values.ts';
export { parse } from './parser.ts';
export { lex } from './lexer.ts';

/** Options for compiling/running a jq program. */
export interface RunOptions {
  /** Environment for `env`/`$ENV`. */
  env?: Record<string, string>;
  /** Named args from `--arg`/`--argjson`, bound as `$name` and in `$ARGS.named`. */
  args?: Record<string, unknown>;
}

/** A parsed jq program, applicable to many inputs. */
export interface CompiledFilter {
  ast: Node;
  /** Apply the filter to one input, yielding each output value. */
  run(input: unknown, options?: RunOptions): Generator<unknown>;
}

function makeRootEnv(ctx: Context): Env {
  const root = new Env(null);
  // Bind --arg/--argjson named vars and $ARGS.
  for (const [k, v] of Object.entries(ctx.args)) root.vars.set(k, v);
  root.vars.set('ENV', ctx.env);
  root.vars.set('ARGS', { positional: [], named: { ...ctx.args } });
  root.vars.set('__prog_args', []);
  return root;
}

/** Parse `program` into a reusable {@link CompiledFilter}. */
export function compile(program: string): CompiledFilter {
  const ast = parse(program);
  return {
    ast,
    *run(input: unknown, options: RunOptions = {}): Generator<unknown> {
      const ctx: Context = { env: options.env ?? {}, args: options.args ?? {} };
      const root = makeRootEnv(ctx);
      yield* evalNode(ast, input, root, ctx);
    },
  };
}

/** Compile + run `program` against `input`, returning all outputs as an array. */
export function run(program: string, input: unknown, options: RunOptions = {}): unknown[] {
  return [...compile(program).run(input, options)];
}

export type { Context } from './interp.ts';
