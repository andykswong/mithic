/**
 * jq interpreter — a generator-based tree-walking evaluator. Each filter
 * {@link Node} is evaluated by {@link evalNode} as a generator of output values
 * (jq filters are 1→many). Streaming/backtracking semantics (`,`, `[]`, `//`,
 * `reduce`, function args that themselves stream) fall out naturally from
 * `yield*` over nested generators.
 *
 * The {@link Env} is an immutable scope chain holding `$variables` and user
 * `def` functions (with closures). `error`, `label`/`break`, and `limit` are
 * implemented via thrown control signals ({@link JQError}, {@link BreakSignal}).
 */
import type { Node, Pattern } from './ast.ts';
import { compare, equal, toStr, truthy, typeOf } from './values.ts';
import { applyFormat } from './builtins.ts';
import { callBuiltin, isBuiltin } from './builtins.ts';

/** A jq `error` — carries an arbitrary jq value (string or otherwise). */
export class JQError extends Error {
  value: unknown;
  constructor(value: unknown) {
    super(typeof value === 'string' ? value : JSON.stringify(value));
    this.value = value;
  }
}

/** Internal control signal for `label $x | … break $x`. */
export class BreakSignal {
  name: string;
  constructor(name: string) { this.name = name; }
}

/** A bound user function: its formal params, body, and the env it closed over. */
export interface FuncDef {
  params: string[];
  body: Node;
  env: Env;
}

/** A filter argument passed to a function: a closure capturing the call-site env. */
export interface Closure {
  node: Node;
  env: Env;
}

/**
 * The lexical scope chain. Variables and functions are looked up by walking the
 * `parent` links. New bindings produce a child env (persistent / no mutation),
 * so backtracking and recursion see the right scope automatically.
 */
export class Env {
  vars: Map<string, unknown>;
  funcs: Map<string, FuncDef>;
  /** Filter-valued arguments (jq function params without `$`). */
  closures: Map<string, Closure>;
  parent: Env | null;

  constructor(parent: Env | null = null) {
    this.vars = new Map();
    this.funcs = new Map();
    this.closures = new Map();
    this.parent = parent;
  }

  child(): Env { return new Env(this); }

  lookupVar(name: string): unknown {
    let e: Env | null = this.parent;
    if (this.vars.has(name)) return this.vars.get(name);
    while (e !== null) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    throw new JQError(`$${name} is not defined`);
  }

  lookupFunc(key: string): FuncDef | undefined {
    let e: Env | null = this.parent;
    const own = this.funcs.get(key);
    if (own) return own;
    while (e !== null) {
      const f = e.funcs.get(key);
      if (f) return f;
      e = e.parent;
    }
    return undefined;
  }

  lookupClosure(name: string): Closure | undefined {
    let e: Env | null = this.parent;
    const own = this.closures.get(name);
    if (own) return own;
    while (e !== null) {
      const c = e.closures.get(name);
      if (c) return c;
      e = e.parent;
    }
    return undefined;
  }
}

/** Runtime context shared across an evaluation (env vars, $__loc__ source). */
export interface Context {
  /** `$ENV` / `env` builtin source. */
  env: Record<string, string>;
  /** Named CLI args ($name) from --arg/--argjson, exposed via $ARGS too. */
  args: Record<string, unknown>;
}

/** Evaluate a program node against `input`, yielding each output value. */
export function* evalNode(node: Node, input: unknown, env: Env, ctx: Context): Generator<unknown> {
  switch (node.kind) {
    case 'identity':
      yield input;
      return;

    case 'recurseDefault':
      yield* recurse(input);
      return;

    case 'literal':
      yield node.value;
      return;

    case 'var':
      yield env.lookupVar(node.name);
      return;

    case 'loc':
      yield { file: '<stdin>', line: 1 };
      return;

    case 'index': {
      for (const t of evalNode(node.target, input, env, ctx)) {
        for (const idx of evalNode(node.index, input, env, ctx)) {
          try {
            yield indexValue(t, idx);
          } catch (e) {
            if (node.optional && e instanceof JQError) continue;
            throw e;
          }
        }
      }
      return;
    }

    case 'slice': {
      for (const t of evalNode(node.target, input, env, ctx)) {
        const froms = node.from ? [...evalNode(node.from, input, env, ctx)] : [null];
        const tos = node.to ? [...evalNode(node.to, input, env, ctx)] : [null];
        for (const f of froms) for (const to of tos) {
          try {
            yield sliceValue(t, f, to);
          } catch (e) {
            if (node.optional && e instanceof JQError) continue;
            throw e;
          }
        }
      }
      return;
    }

    case 'iterate': {
      for (const t of evalNode(node.target, input, env, ctx)) {
        try {
          if (Array.isArray(t)) { yield* t; }
          else if (t !== null && typeof t === 'object') { yield* Object.values(t as Record<string, unknown>); }
          else throw new JQError(`Cannot iterate over ${typeOf(t)} (${shortVal(t)})`);
        } catch (e) {
          if (node.optional && e instanceof JQError) continue;
          throw e;
        }
      }
      return;
    }

    case 'pipe': {
      for (const v of evalNode(node.left, input, env, ctx)) {
        yield* evalNode(node.right, v, env, ctx);
      }
      return;
    }

    case 'comma':
      yield* evalNode(node.left, input, env, ctx);
      yield* evalNode(node.right, input, env, ctx);
      return;

    case 'array': {
      if (node.body === null) { yield []; return; }
      yield [...evalNode(node.body, input, env, ctx)];
      return;
    }

    case 'object':
      yield* evalObject(node.entries, 0, {}, input, env, ctx);
      return;

    case 'strinterp': {
      yield* evalStrInterp(node, 0, '', input, env, ctx);
      return;
    }

    case 'format':
      // Bare `@fmt` as a filter applies the format to its input.
      yield applyFormat(node.name, input);
      return;

    case 'negate': {
      for (const v of evalNode(node.operand, input, env, ctx)) {
        if (typeof v !== 'number') throw new JQError(`${typeOf(v)} (${shortVal(v)}) cannot be negated`);
        yield -v;
      }
      return;
    }

    case 'binop': {
      for (const l of evalNode(node.left, input, env, ctx)) {
        for (const r of evalNode(node.right, input, env, ctx)) {
          yield applyBinop(node.op, l, r);
        }
      }
      return;
    }

    case 'and': {
      for (const l of evalNode(node.left, input, env, ctx)) {
        if (!truthy(l)) { yield false; continue; }
        for (const r of evalNode(node.right, input, env, ctx)) yield truthy(r);
      }
      return;
    }

    case 'or': {
      for (const l of evalNode(node.left, input, env, ctx)) {
        if (truthy(l)) { yield true; continue; }
        for (const r of evalNode(node.right, input, env, ctx)) yield truthy(r);
      }
      return;
    }

    case 'alternative': {
      // `a // b`: yield the truthy outputs of `a`; if `a` produced no truthy
      // value (it was empty, or emitted only `null`/`false`), yield `b`.
      // A raised error from `a` PROPAGATES — it is not an "absence of value".
      let any = false;
      for (const v of evalNode(node.left, input, env, ctx)) {
        if (truthy(v)) { any = true; yield v; }
      }
      if (!any) yield* evalNode(node.right, input, env, ctx);
      return;
    }

    case 'optional': {
      try {
        yield* evalNode(node.body, input, env, ctx);
      } catch (e) {
        if (e instanceof JQError) return;
        throw e;
      }
      return;
    }

    case 'if': {
      for (const c of evalNode(node.cond, input, env, ctx)) {
        yield* evalIf(node, c, input, env, ctx);
      }
      return;
    }

    case 'try': {
      try {
        yield* evalNode(node.body, input, env, ctx);
      } catch (e) {
        if (e instanceof JQError) {
          if (node.catch) yield* evalNode(node.catch, e.value, env, ctx);
          return;
        }
        throw e;
      }
      return;
    }

    case 'reduce': {
      for (const acc of evalNode(node.init, input, env, ctx)) {
        let state = acc;
        for (const item of evalNode(node.source, input, env, ctx)) {
          const cenv = bindPattern(node.pattern, item, env, ctx);
          let last: unknown = null;
          let produced = false;
          for (const s of evalNode(node.update, state, cenv, ctx)) { last = s; produced = true; }
          state = produced ? last : null;
        }
        yield state;
      }
      return;
    }

    case 'foreach': {
      for (const acc of evalNode(node.init, input, env, ctx)) {
        let state = acc;
        for (const item of evalNode(node.source, input, env, ctx)) {
          const cenv = bindPattern(node.pattern, item, env, ctx);
          for (const s of evalNode(node.update, state, cenv, ctx)) {
            state = s;
            if (node.extract) yield* evalNode(node.extract, state, cenv, ctx);
            else yield state;
          }
        }
      }
      return;
    }

    case 'bind': {
      for (const v of evalNode(node.source, input, env, ctx)) {
        yield* bindAlternatives(node.patterns, 0, v, input, env, ctx, node.body);
      }
      return;
    }

    case 'funcdef': {
      const fenv = env.child();
      fenv.funcs.set(`${node.name}/${node.params.length}`, { params: node.params, body: node.body, env: fenv });
      yield* evalNode(node.rest, input, fenv, ctx);
      return;
    }

    case 'call':
      yield* evalCall(node, input, env, ctx);
      return;

    case 'label': {
      try {
        yield* evalNode(node.body, input, env, ctx);
      } catch (e) {
        if (e instanceof BreakSignal && e.name === node.name) return;
        throw e;
      }
      return;
    }

    case 'break':
      throw new BreakSignal(node.name);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function* evalIf(node: Extract<Node, { kind: 'if' }>, cond: unknown, input: unknown, env: Env, ctx: Context): Generator<unknown> {
  if (truthy(cond)) { yield* evalNode(node.then, input, env, ctx); return; }
  for (const { cond: ec, then } of node.elifs) {
    for (const c of evalNode(ec, input, env, ctx)) {
      if (truthy(c)) { yield* evalNode(then, input, env, ctx); return; }
    }
  }
  if (node.else) yield* evalNode(node.else, input, env, ctx);
  else yield input; // `if c then x end` with no else → identity on falsy
}

function* evalObject(entries: Extract<Node, { kind: 'object' }>['entries'], i: number, acc: Record<string, unknown>, input: unknown, env: Env, ctx: Context): Generator<unknown> {
  if (i >= entries.length) { yield { ...acc }; return; }
  const { key, value } = entries[i];
  for (const k of evalNode(key, input, env, ctx)) {
    if (typeof k !== 'string') throw new JQError(`Object keys must be strings, got ${typeOf(k)}`);
    const valNode = value ?? ({ kind: 'index', target: { kind: 'identity' }, index: { kind: 'literal', value: k }, optional: false } as Node);
    for (const v of evalNode(valNode, input, env, ctx)) {
      yield* evalObject(entries, i + 1, { ...acc, [k]: v }, input, env, ctx);
    }
  }
}

function* evalStrInterp(node: Extract<Node, { kind: 'strinterp' }>, i: number, acc: string, input: unknown, env: Env, ctx: Context): Generator<unknown> {
  if (i >= node.parts.length) { yield acc; return; }
  const part = node.parts[i];
  if (part.type === 'lit') { yield* evalStrInterp(node, i + 1, acc + part.value, input, env, ctx); return; }
  for (const v of evalNode(part.node, input, env, ctx)) {
    const piece = node.format ? applyFormat(node.format, v) : toStr(v);
    yield* evalStrInterp(node, i + 1, acc + piece, input, env, ctx);
  }
}

function* bindAlternatives(patterns: Pattern[], i: number, value: unknown, input: unknown, env: Env, ctx: Context, body: Node): Generator<unknown> {
  // For multiple `?//` patterns, try each in turn; on error fall to the next.
  const isLast = i === patterns.length - 1;
  try {
    const cenv = bindPattern(patterns[i], value, env, ctx);
    yield* evalNode(body, input, cenv, ctx);
  } catch (e) {
    if (!isLast && e instanceof JQError) {
      yield* bindAlternatives(patterns, i + 1, value, input, env, ctx, body);
      return;
    }
    throw e;
  }
}

/** Bind a destructuring pattern, returning a child env with the new vars. */
export function bindPattern(pattern: Pattern, value: unknown, env: Env, ctx: Context): Env {
  const cenv = env.child();
  doBind(pattern, value, cenv, ctx);
  return cenv;
}

function doBind(pattern: Pattern, value: unknown, env: Env, ctx: Context): void {
  switch (pattern.kind) {
    case 'var':
      env.vars.set(pattern.name, value);
      return;
    case 'array': {
      const arr = Array.isArray(value) ? value : [];
      pattern.elements.forEach((p, i) => doBind(p, arr[i] ?? null, env, ctx));
      return;
    }
    case 'object': {
      for (const entry of pattern.entries) {
        let key: string;
        if (entry.keyVar !== undefined) {
          key = entry.keyVar;
          env.vars.set(entry.keyVar, indexValue(value, key));
        } else {
          const keyNode = entry.key!;
          const [k] = [...evalNode(keyNode, value, env, ctx)];
          key = typeof k === 'string' ? k : String(k);
        }
        doBind(entry.value, indexValue(value, key), env, ctx);
      }
      return;
    }
  }
}

/** Recurse: `..` — emit the input and every descendant value, depth-first. */
export function* recurse(v: unknown): Generator<unknown> {
  yield v;
  if (Array.isArray(v)) { for (const e of v) yield* recurse(e); }
  else if (v !== null && typeof v === 'object') { for (const e of Object.values(v as Record<string, unknown>)) yield* recurse(e); }
}

/** Index a value by a key (string→object field, number→array element). */
export function indexValue(target: unknown, index: unknown): unknown {
  if (target === null || target === undefined) {
    if (typeof index === 'string' || typeof index === 'number' || (index && typeof index === 'object')) return null;
  }
  if (typeof index === 'string') {
    if (target === null || target === undefined) return null;
    if (typeof target === 'object' && !Array.isArray(target)) {
      const o = target as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(o, index) ? o[index] : null;
    }
    throw new JQError(`Cannot index ${typeOf(target)} with "${index}"`);
  }
  if (typeof index === 'number') {
    if (target === null || target === undefined) return null;
    if (Array.isArray(target)) {
      const i = index < 0 ? target.length + Math.floor(index) : Math.floor(index);
      return i >= 0 && i < target.length ? target[i] : null;
    }
    throw new JQError(`Cannot index ${typeOf(target)} with number`);
  }
  // array index by array → indices (jq `.[ [v] ]` finds sublist positions); rare
  if (Array.isArray(index)) {
    if (!Array.isArray(target)) throw new JQError(`Cannot index ${typeOf(target)} with array`);
    return indicesOf(target, index);
  }
  if (index === null) throw new JQError(`Cannot index ${typeOf(target)} with null`);
  throw new JQError(`Cannot index ${typeOf(target)} with ${typeOf(index)}`);
}

function indicesOf(haystack: unknown[], needle: unknown[]): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (!equal(haystack[i + j], needle[j])) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

/** Slice a string or array `[from:to]` with jq's negative-index semantics. */
export function sliceValue(target: unknown, from: unknown, to: unknown): unknown {
  if (target === null || target === undefined) return null;
  const len = Array.isArray(target) ? target.length : (typeof target === 'string' ? target.length : -1);
  if (len < 0) throw new JQError(`Cannot index ${typeOf(target)} with object`);
  const norm = (x: unknown, dflt: number): number => {
    if (x === null || x === undefined) return dflt;
    if (typeof x !== 'number') throw new JQError('slice indices must be numbers');
    let i = Math.floor(x);
    if (i < 0) i += len;
    return Math.max(0, Math.min(len, i));
  };
  const f = norm(from, 0);
  const t = norm(to, len);
  if (Array.isArray(target)) return target.slice(f, Math.max(f, t));
  return (target as string).slice(f, Math.max(f, t));
}

const ARITH: Record<string, true> = { '+': true, '-': true, '*': true, '/': true, '%': true };

/** Apply a binary operator with jq's per-type semantics. */
export function applyBinop(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case '==': return equal(l, r);
    case '!=': return !equal(l, r);
    case '<': return compare(l, r) < 0;
    case '<=': return compare(l, r) <= 0;
    case '>': return compare(l, r) > 0;
    case '>=': return compare(l, r) >= 0;
  }
  if (ARITH[op]) return arith(op, l, r);
  throw new JQError(`unknown operator ${op}`);
}

function arith(op: string, l: unknown, r: unknown): unknown {
  const tl = typeOf(l), tr = typeOf(r);
  if (op === '+') {
    if (l === null) return r;
    if (r === null) return l;
    if (tl === 'number' && tr === 'number') return (l as number) + (r as number);
    if (tl === 'string' && tr === 'string') return (l as string) + (r as string);
    if (tl === 'array' && tr === 'array') return [...(l as unknown[]), ...(r as unknown[])];
    if (tl === 'object' && tr === 'object') return { ...(l as object), ...(r as object) };
    throw new JQError(`${tl} (${shortVal(l)}) and ${tr} (${shortVal(r)}) cannot be added`);
  }
  if (op === '-') {
    if (tl === 'number' && tr === 'number') return (l as number) - (r as number);
    if (tl === 'array' && tr === 'array') return (l as unknown[]).filter((e) => !(r as unknown[]).some((x) => equal(x, e)));
    throw new JQError(`${tl} (${shortVal(l)}) and ${tr} (${shortVal(r)}) cannot be subtracted`);
  }
  if (op === '*') {
    if (tl === 'number' && tr === 'number') return (l as number) * (r as number);
    // string * number → repeat (jq: n<=0 → null)
    if (tl === 'string' && tr === 'number') return (r as number) > 0 ? (l as string).repeat(Math.floor(r as number)) : null;
    if (tl === 'number' && tr === 'string') return (l as number) > 0 ? (r as string).repeat(Math.floor(l as number)) : null;
    if (tl === 'object' && tr === 'object') return deepMerge(l as Record<string, unknown>, r as Record<string, unknown>);
    throw new JQError(`${tl} and ${tr} cannot be multiplied`);
  }
  if (op === '/') {
    if (tl === 'number' && tr === 'number') {
      if ((r as number) === 0) throw new JQError(`${tl} (${shortVal(l)}) and ${tr} (${shortVal(r)}) cannot be divided because the divisor is zero`);
      return (l as number) / (r as number);
    }
    if (tl === 'string' && tr === 'string') return (r as string) === '' ? (l as string).split('') : (l as string).split(r as string);
    throw new JQError(`${tl} and ${tr} cannot be divided`);
  }
  if (op === '%') {
    if (tl === 'number' && tr === 'number') {
      const ri = Math.trunc(r as number);
      if (ri === 0) throw new JQError(`${tl} and ${tr} cannot be divided because the divisor is zero`);
      const a = Math.trunc(l as number);
      return (a % Math.abs(ri)) * 1; // jq uses C-style with sign of dividend
    }
    throw new JQError(`${tl} and ${tr} cannot be divided`);
  }
  throw new JQError(`unknown operator ${op}`);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const k of Object.keys(b)) {
    const av = out[k], bv = b[k];
    if (av && bv && typeOf(av) === 'object' && typeOf(bv) === 'object') {
      out[k] = deepMerge(av as Record<string, unknown>, bv as Record<string, unknown>);
    } else out[k] = bv;
  }
  return out;
}

function shortVal(v: unknown): string {
  const s = toStr(v);
  return s.length > 11 ? s.slice(0, 10) + '...' : s;
}

// ── function calls ─────────────────────────────────────────────────────────

function* evalCall(node: Extract<Node, { kind: 'call' }>, input: unknown, env: Env, ctx: Context): Generator<unknown> {
  const { name, args } = node;

  // closure parameter call (0-arg filter argument): map(f) binds `f`.
  if (args.length === 0) {
    const closure = env.lookupClosure(name);
    if (closure) { yield* evalNode(closure.node, input, closure.env, ctx); return; }
  }

  // user-defined function?
  const key = `${name}/${args.length}`;
  const fn = env.lookupFunc(key);
  if (fn) {
    // Filter (non-$) params close over the CALLER's env; $value params are
    // expanded as a cartesian product over each arg's output stream.
    const baseEnv = fn.env.child();
    const valueParams: Array<{ name: string; node: Node }> = [];
    fn.params.forEach((p, i) => {
      if (p.startsWith('$')) valueParams.push({ name: p.slice(1), node: args[i] });
      else baseEnv.closures.set(p, { node: args[i], env });
    });
    yield* bindValueParams(valueParams, 0, fn, baseEnv, input, env, ctx);
    return;
  }

  // builtin?
  if (isBuiltin(name, args.length)) {
    yield* callBuiltin(name, args, input, env, ctx, evalNode, callHelpers);
    return;
  }

  throw new JQError(`${name}/${args.length} is not defined`);
}

// Bind `$value` params one at a time, expanding each arg's output stream
// (cartesian product), then evaluate the function body in the resulting env.
function* bindValueParams(
  valueParams: Array<{ name: string; node: Node }>,
  idx: number,
  fn: FuncDef,
  cenv: Env,
  input: unknown,
  callerEnv: Env,
  ctx: Context,
): Generator<unknown> {
  if (idx >= valueParams.length) { yield* evalNode(fn.body, input, cenv, ctx); return; }
  const { name, node } = valueParams[idx];
  for (const v of evalNode(node, input, callerEnv, ctx)) {
    const child = cenv.child();
    child.vars.set(name, v);
    yield* bindValueParams(valueParams, idx + 1, fn, child, input, callerEnv, ctx);
  }
}

// Helper bag passed to builtins so they can re-enter the evaluator.
const callHelpers = {
  recurse,
  indexValue,
  sliceValue,
  applyBinop,
  JQError,
};

export type CallHelpers = typeof callHelpers;
