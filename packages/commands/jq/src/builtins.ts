/**
 * jq builtin functions. Builtins fall into two groups:
 *
 *  - **Simple** (1 input value → values), registered in {@link SIMPLE} keyed by
 *    `name/arity`. They receive the input plus already-materialized arg streams.
 *  - **Higher-order** (`map`, `select`, `reduce`-likes, `recurse`, `limit`,
 *    `first`, …) need to re-enter the evaluator with the filter-arg nodes, so
 *    they're handled in {@link callBuiltin} with access to `evalNode`.
 *
 * Keeping the arithmetic/string/array builtins data-driven keeps the surface
 * area honest and the dispatch fast; the control-flow-ish ones are explicit.
 */
import type { Node } from './ast.ts';
import type { Context, Env } from './interp.ts';
import { HaltError, JQError, isCatchable } from './interp.ts';
import { compare, equal, toJSON, toStr, truthy, typeOf } from './values.ts';
import type { JQType } from './values.ts';

// evalNode is injected (helpers bag) to avoid invoking the interpreter at
// module-eval time; the import of JQError above is a live binding only used
// inside function bodies, so the interp↔builtins cycle resolves safely.
type EvalFn = (node: Node, input: unknown, env: Env, ctx: Context) => Generator<unknown>;

interface Helpers {
  recurse: (v: unknown) => Generator<unknown>;
  indexValue: (t: unknown, i: unknown) => unknown;
  sliceValue: (t: unknown, f: unknown, to: unknown) => unknown;
  applyBinop: (op: string, l: unknown, r: unknown) => unknown;
  JQError: new (v: unknown) => Error & { value: unknown };
}

let H: Helpers;
/** Construct a jq error. Uses {@link JQError} directly so it works even before
 * any builtin call has populated the helper bag (fixes the bare-`@format`
 * TypeError crash). */
function err(v: unknown): Error { return new JQError(v); }

// ── simple builtins: (input, ...materialized-args) => value | values[] ──────

type SimpleFn = (input: unknown, args: unknown[]) => unknown | unknown[];
/** Marker wrapper: the builtin returns MULTIPLE outputs (a stream). */
class Multi { vals: unknown[]; constructor(v: unknown[]) { this.vals = v; } }
const multi = (vals: unknown[]): Multi => new Multi(vals);

const SIMPLE: Record<string, SimpleFn> = {
  'length/0': (input) => lengthOf(input),
  'utf8bytelength/0': (input) => { if (typeof input !== 'string') throw err(`${typeOf(input)} only strings have UTF-8 byte length`); return new TextEncoder().encode(input).length; },
  'keys/0': (input) => keysOf(input, true),
  'keys_unsorted/0': (input) => keysOf(input, false),
  'has/1': (input, [k]) => hasKey(input, k),
  'in/1': (input, [c]) => hasKey(c, input),
  'contains/1': (input, [b]) => containsVal(input, b),
  'inside/1': (input, [b]) => containsVal(b, input),
  'add/0': (input) => addAll(input),
  'type/0': (input) => typeOf(input),
  'not/0': (input) => !truthy(input),
  'empty/0': () => multi([]),
  'error/0': (input) => { throw err(input); },
  'error/1': (_input, [m]) => { throw err(m); },
  'tostring/0': (input) => toStr(input),
  'tonumber/0': (input) => toNumber(input),
  'tojson/0': (input) => toJSON(input, 0),
  'fromjson/0': (input) => { if (typeof input !== 'string') throw err('fromjson requires a string'); return JSON.parse(input); },
  'ascii_downcase/0': (input) => asciiCase(reqStr(input), false),
  'ascii_upcase/0': (input) => asciiCase(reqStr(input), true),
  'explode/0': (input) => Array.from(reqStr(input)).map((c) => c.codePointAt(0)!),
  'implode/0': (input) => { if (!Array.isArray(input)) throw err('implode requires array'); return String.fromCodePoint(...(input as number[])); },
  'ltrimstr/1': (input, [p]) => (typeof input === 'string' && typeof p === 'string' && input.startsWith(p)) ? input.slice(p.length) : input,
  'rtrimstr/1': (input, [p]) => (typeof input === 'string' && typeof p === 'string' && input.endsWith(p)) ? input.slice(0, input.length - (p as string).length) : input,
  'startswith/1': (input, [p]) => reqStr(input).startsWith(reqStrArg(p)),
  'endswith/1': (input, [p]) => reqStr(input).endsWith(reqStrArg(p)),
  'ascii/0': (input) => String.fromCharCode(input as number),
  'tostream/0': (input) => multi([...toStream(input)]),
  'floor/0': (input) => Math.floor(reqNum(input)),
  'ceil/0': (input) => Math.ceil(reqNum(input)),
  'round/0': (input) => Math.round(reqNum(input)),
  'fabs/0': (input) => Math.abs(reqNum(input)),
  'abs/0': (input) => typeof input === 'number' ? Math.abs(input) : input,
  'sqrt/0': (input) => Math.sqrt(reqNum(input)),
  'pow/2': (_i, [a, b]) => Math.pow(reqNum(a), reqNum(b)),
  'log/0': (input) => Math.log(reqNum(input)),
  'log10/0': (input) => Math.log10(reqNum(input)),
  'log2/0': (input) => Math.log2(reqNum(input)),
  'exp/0': (input) => Math.exp(reqNum(input)),
  'exp10/0': (input) => Math.pow(10, reqNum(input)),
  'exp2/0': (input) => Math.pow(2, reqNum(input)),
  'reverse/0': (input) => reverseOf(input),
  'sort/0': (input) => sortArr(input),
  'unique/0': (input) => uniqueArr(input),
  'flatten/0': (input) => flatten(input, Infinity),
  'flatten/1': (input, [d]) => flatten(input, reqNum(d)),
  'min/0': (input) => extremum(input, -1),
  'max/0': (input) => extremum(input, 1),
  'join/1': (input, [sep]) => joinArr(input, sep),
  'split/1': (input, [sep]) => splitStr(input, sep),
  'ascii_only/0': (input) => { const s = reqStr(input); for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false; return true; },
  'to_entries/0': (input) => toEntries(input),
  'from_entries/0': (input) => fromEntries(input),
  'setpath/2': (input, [p, v]) => setPath(input, p as unknown[], v),
  'delpaths/1': (input, [ps]) => delPaths(input, ps as unknown[][]),
  'leaf_paths/0': (input) => multi(leafPaths(input)),
  'env/0': () => CURRENT_CTX!.env,
  'now/0': () => Date.now() / 1000,
  'infinite/0': () => Infinity,
  'nan/0': () => NaN,
  'isinfinite/0': (input) => typeof input === 'number' && !isFinite(input) && !isNaN(input),
  'isnan/0': (input) => typeof input === 'number' && isNaN(input),
  'isnormal/0': (input) => typeof input === 'number' && isFinite(input) && input !== 0,
  'isvalid/1': () => true,
  'splits/1': (input, [re]) => multi([...regexSplit(input, re, undefined)]),
  'test/1': (input, [re]) => regexTest(input, re, undefined),
  'test/2': (input, [re, fl]) => regexTest(input, re, fl as string),
  'match/1': (input, [re]) => multi(regexMatch(input, re, undefined)),
  'match/2': (input, [re, fl]) => multi(regexMatch(input, re, fl as string)),
  'capture/1': (input, [re]) => regexCapture(input, re, undefined),
  'capture/2': (input, [re, fl]) => regexCapture(input, re, fl as string),
  'scan/1': (input, [re]) => multi(regexScan(input, re, undefined)),
  'scan/2': (input, [re, fl]) => multi(regexScan(input, re, fl as string)),
  'transpose/0': (input) => transpose(input),
  'builtins/0': () => BUILTIN_NAMES.slice(),
};

// builtins that re-enter the evaluator (need the arg NODES), keyed by name/arity.
// These take dispatch priority over SIMPLE; do NOT also list them in SIMPLE.
const HIGHER = new Set([
  'map/1', 'map_values/1', 'select/1', 'recurse/0', 'recurse/1', 'recurse/2',
  'any/0', 'any/1', 'any/2', 'all/0', 'all/1', 'all/2',
  'sort_by/1', 'group_by/1', 'unique_by/1', 'min_by/1', 'max_by/1',
  'range/1', 'range/2', 'range/3', 'with_entries/1',
  'first/0', 'first/1', 'last/0', 'last/1', 'nth/1', 'nth/2', 'limit/2',
  'paths/0', 'paths/1', 'del/1', 'until/2', 'while/2', 'repeat/1',
  'walk/1', 'halt/0', 'halt_error/0', 'halt_error/1',
  'splits/2', 'split/2', 'indices/1', 'index/1', 'rindex/1',
  'sub/2', 'gsub/2', 'sub/3', 'gsub/3',
  'objects/0', 'arrays/0', 'booleans/0', 'numbers/0',
  'strings/0', 'nulls/0', 'iterables/0', 'scalars/0', 'values/0',
  'combinations/0', 'getpath/1',
  'path/1', 'isempty/1', 'debug/0', 'debug/1', 'input/0', 'inputs/0',
]);

/** True if `name/arity` is provided by SIMPLE or the higher-order set. */
export function isBuiltin(name: string, arity: number): boolean {
  const key = `${name}/${arity}`;
  if (name === '@@env') return true;
  if (name.startsWith('@@assign:')) return true;
  return key in SIMPLE || HIGHER.has(key);
}

/**
 * The `builtins/0` listing: every `name/arity` jq recognizes (the union of the
 * SIMPLE and higher-order tables), sorted for stable output. Internal markers
 * (`@@…`) are excluded.
 */
const BUILTIN_NAMES: string[] = (() => {
  const set = new Set<string>([...Object.keys(SIMPLE), ...HIGHER]);
  return [...set].filter((k) => !k.startsWith('@@')).sort();
})();

let CURRENT_CTX: Context | null = null;

/** Apply a `@format` to a value (used by format strings and bare `@fmt`). */
export function applyFormat(name: string, v: unknown): string {
  switch (name) {
    case '@text': return toStr(v);
    case '@json': return toJSON(v, 0);
    case '@base64': return base64Encode(toStr(v));
    case '@base64d': return base64Decode(toStr(v));
    case '@uri': return uriEncode(toStr(v));
    case '@csv': return rowFormat(v, ',', csvCell);
    case '@tsv': return rowFormat(v, '\t', tsvCell);
    case '@html': return htmlEscape(toStr(v));
    case '@sh': return shFormat(v);
    default: throw err(`${name} is not a valid format`);
  }
}

/**
 * Dispatch a builtin call. `args` are the raw AST arg nodes; SIMPLE builtins
 * have their args fully materialized (cartesian over multi-output args), while
 * higher-order builtins receive the nodes to re-enter the evaluator.
 */
export function* callBuiltin(
  name: string,
  args: Node[],
  input: unknown,
  env: Env,
  ctx: Context,
  evalNode: EvalFn,
  helpers: Helpers,
): Generator<unknown> {
  H = helpers;
  CURRENT_CTX = ctx;
  const key = `${name}/${args.length}`;

  // assignment operators desugared by the parser into `@@assign:OP`.
  if (name.startsWith('@@assign:')) {
    yield* evalAssign(name.slice('@@assign:'.length), args[0], args[1], input, env, ctx, evalNode);
    return;
  }
  if (name === '@@env') { yield ctx.env; return; }

  // higher-order builtins take priority (they need the raw arg nodes).
  if (HIGHER.has(key)) {
    yield* callHigher(name, args, input, env, ctx, evalNode);
    return;
  }

  // simple builtins: materialize all arg streams (cartesian product)
  const fn = SIMPLE[key];
  if (!fn) throw err(`${name}/${args.length} is not defined`);
  yield* applySimple(fn, args, 0, [], input, env, ctx, evalNode);
}

function* applySimple(fn: SimpleFn, args: Node[], i: number, acc: unknown[], input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<unknown> {
  if (i >= args.length) {
    const out = fn(input, acc);
    if (out instanceof Multi) yield* out.vals;
    else yield out;
    return;
  }
  for (const v of evalNode(args[i], input, env, ctx)) {
    yield* applySimple(fn, args, i + 1, [...acc, v], input, env, ctx, evalNode);
  }
}

// ── higher-order implementations ────────────────────────────────────────────

function* callHigher(name: string, args: Node[], input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<unknown> {
  const a = args;
  switch (`${name}/${args.length}`) {
    case 'map/1': {
      if (!Array.isArray(input) && (input === null || typeof input !== 'object')) throw err(`Cannot iterate over ${typeOf(input)}`);
      const items = Array.isArray(input) ? input : Object.values(input as object);
      const out: unknown[] = [];
      for (const item of items) for (const r of evalNode(a[0], item, env, ctx)) out.push(r);
      yield out;
      return;
    }
    case 'map_values/1': {
      if (Array.isArray(input)) {
        const out: unknown[] = [];
        for (const item of input) { const r = first(evalNode(a[0], item, env, ctx)); if (r.has) out.push(r.value); }
        yield out;
      } else if (input && typeof input === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(input as object)) { const r = first(evalNode(a[0], item, env, ctx)); if (r.has) out[k] = r.value; }
        yield out;
      } else throw err(`Cannot iterate over ${typeOf(input)}`);
      return;
    }
    case 'select/1': {
      for (const c of evalNode(a[0], input, env, ctx)) if (truthy(c)) yield input;
      return;
    }
    case 'recurse/0': yield* H.recurse(input); return;
    case 'recurse/1': { yield* recurseF(a[0], null, input, env, ctx, evalNode); return; }
    case 'recurse/2': { yield* recurseF(a[0], a[1], input, env, ctx, evalNode); return; }
    case 'any/0': { yield Array.isArray(input) && input.some(truthy); return; }
    case 'all/0': { yield Array.isArray(input) && input.every(truthy); return; }
    case 'any/1': { let r = false; for (const item of iter(input)) { for (const c of evalNode(a[0], item, env, ctx)) if (truthy(c)) { r = true; } } yield r; return; }
    case 'all/1': { let r = true; for (const item of iter(input)) { for (const c of evalNode(a[0], item, env, ctx)) if (!truthy(c)) { r = false; } } yield r; return; }
    case 'any/2': { let r = false; for (const item of evalNode(a[0], input, env, ctx)) { for (const c of evalNode(a[1], item, env, ctx)) if (truthy(c)) r = true; } yield r; return; }
    case 'all/2': { let r = true; for (const item of evalNode(a[0], input, env, ctx)) { for (const c of evalNode(a[1], item, env, ctx)) if (!truthy(c)) r = false; } yield r; return; }
    case 'sort_by/1': { yield sortByKey(input, a[0], env, ctx, evalNode); return; }
    case 'group_by/1': { yield groupByKey(input, a[0], env, ctx, evalNode); return; }
    case 'unique_by/1': { yield uniqueByKey(input, a[0], env, ctx, evalNode); return; }
    case 'min_by/1': { yield extremumBy(input, a[0], env, ctx, evalNode, -1); return; }
    case 'max_by/1': { yield extremumBy(input, a[0], env, ctx, evalNode, 1); return; }
    case 'range/1': { for (const hi of evalNode(a[0], input, env, ctx)) yield* rangeGen(0, reqNum(hi), 1); return; }
    case 'range/2': { for (const lo of evalNode(a[0], input, env, ctx)) for (const hi of evalNode(a[1], input, env, ctx)) yield* rangeGen(reqNum(lo), reqNum(hi), 1); return; }
    case 'range/3': { for (const lo of evalNode(a[0], input, env, ctx)) for (const hi of evalNode(a[1], input, env, ctx)) for (const st of evalNode(a[2], input, env, ctx)) yield* rangeGen(reqNum(lo), reqNum(hi), reqNum(st)); return; }
    case 'with_entries/1': {
      const entries = toEntries(input) as unknown[];
      const mapped: unknown[] = [];
      for (const e of entries) for (const r of evalNode(a[0], e, env, ctx)) mapped.push(r);
      yield fromEntries(mapped);
      return;
    }
    case 'first/0': { if (!Array.isArray(input)) throw err(`Cannot index ${typeOf(input)} with number`); yield input.length ? input[0] : null; return; }
    case 'last/0': { if (!Array.isArray(input)) throw err(`Cannot index ${typeOf(input)} with number`); yield input.length ? input[input.length - 1] : null; return; }
    case 'first/1': { const r = first(evalNode(a[0], input, env, ctx)); if (r.has) yield r.value; return; }
    case 'last/1': { let last: unknown; let has = false; for (const v of evalNode(a[0], input, env, ctx)) { last = v; has = true; } if (has) yield last; return; }
    case 'nth/1': { const n = reqNum(first(evalNode(a[0], input, env, ctx)).value); if (!Array.isArray(input)) throw err('Cannot index'); yield input[n] ?? null; return; }
    case 'nth/2': { for (const nn of evalNode(a[0], input, env, ctx)) { const n = reqNum(nn); if (n < 0) throw err('Out of bounds negative array index'); let i = 0; for (const v of evalNode(a[1], input, env, ctx)) { if (i++ === n) { yield v; break; } } } return; }
    case 'limit/2': {
      for (const nn of evalNode(a[0], input, env, ctx)) {
        const n = reqNum(nn);
        if (n <= 0) continue;
        let i = 0;
        for (const v of evalNode(a[1], input, env, ctx)) { yield v; if (++i >= n) break; }
      }
      return;
    }
    case 'paths/0': { for (const p of allPaths(input)) if (p.length) yield p; return; }
    case 'paths/1': { for (const p of allPaths(input)) { if (!p.length) continue; const leaf = getPath(input, p); let ok = false; for (const c of evalNode(a[0], leaf, env, ctx)) if (truthy(c)) ok = true; if (ok) yield p; } return; }
    case 'del/1': { const paths = collectPaths(a[0], input, env, ctx, evalNode); yield delPaths(input, paths); return; }
    case 'until/2': {
      let v = input;
      for (;;) {
        const cond = first(evalNode(a[0], v, env, ctx));
        if (cond.has && truthy(cond.value)) break;
        const nx = first(evalNode(a[1], v, env, ctx));
        if (!nx.has) break;
        v = nx.value;
      }
      yield v; return;
    }
    case 'while/2': {
      let v = input;
      for (;;) {
        const cond = first(evalNode(a[0], v, env, ctx));
        if (!cond.has || !truthy(cond.value)) break;
        yield v;
        const nx = first(evalNode(a[1], v, env, ctx));
        if (!nx.has) break;
        v = nx.value;
      }
      return;
    }
    case 'repeat/1': { let v = input; for (;;) { const r = first(evalNode(a[0], v, env, ctx)); if (!r.has) break; yield r.value; v = r.value; } return; }
    case 'walk/1': { yield walk(input, a[0], env, ctx, evalNode); return; }
    case 'objects/0': if (typeOf(input) === 'object') yield input; return;
    case 'arrays/0': if (Array.isArray(input)) yield input; return;
    case 'booleans/0': if (typeof input === 'boolean') yield input; return;
    case 'numbers/0': if (typeof input === 'number') yield input; return;
    case 'strings/0': if (typeof input === 'string') yield input; return;
    case 'nulls/0': if (input === null) yield input; return;
    case 'iterables/0': if (Array.isArray(input) || typeOf(input) === 'object') yield input; return;
    case 'scalars/0': if (!Array.isArray(input) && typeOf(input) !== 'object') yield input; return;
    case 'values/0': if (input !== null) yield input; return;
    case 'indices/1': { for (const x of evalNode(a[0], input, env, ctx)) yield indicesGeneric(input, x); return; }
    case 'index/1': { for (const x of evalNode(a[0], input, env, ctx)) { const r = indicesGeneric(input, x); yield r.length ? r[0] : null; } return; }
    case 'rindex/1': { for (const x of evalNode(a[0], input, env, ctx)) { const r = indicesGeneric(input, x); yield r.length ? r[r.length - 1] : null; } return; }
    case 'getpath/1': { for (const p of evalNode(a[0], input, env, ctx)) yield getPath(input, p as unknown[]); return; }
    case 'splits/2': { for (const re of evalNode(a[0], input, env, ctx)) for (const fl of evalNode(a[1], input, env, ctx)) yield* regexSplit(input, re, fl as string); return; }
    case 'split/2': { for (const re of evalNode(a[0], input, env, ctx)) for (const fl of evalNode(a[1], input, env, ctx)) yield [...regexSplit(input, re, fl as string)]; return; }
    case 'sub/2': { for (const re of evalNode(a[0], input, env, ctx)) yield* regexSub(input, re, a[1], undefined, false, env, ctx, evalNode); return; }
    case 'gsub/2': { for (const re of evalNode(a[0], input, env, ctx)) yield* regexSub(input, re, a[1], undefined, true, env, ctx, evalNode); return; }
    case 'sub/3': { for (const re of evalNode(a[0], input, env, ctx)) for (const fl of evalNode(a[2], input, env, ctx)) yield* regexSub(input, re, a[1], fl as string, false, env, ctx, evalNode); return; }
    case 'gsub/3': { for (const re of evalNode(a[0], input, env, ctx)) for (const fl of evalNode(a[2], input, env, ctx)) yield* regexSub(input, re, a[1], fl as string, true, env, ctx, evalNode); return; }
    case 'combinations/0': { yield* combinations(input as unknown[][], 0, []); return; }
    case 'path/1': { yield* pathExpr(a[0], input, env, ctx, evalNode); return; }
    case 'isempty/1': { let empty = true; for (const _ of evalNode(a[0], input, env, ctx)) { empty = false; break; } yield empty; return; }
    case 'input/0': { yield pullInput(ctx); return; }
    case 'inputs/0': { yield* pullInputs(ctx); return; }
    case 'debug/0': { ctx.debug?.(['DEBUG:', input]); yield input; return; }
    case 'debug/1': { for (const m of evalNode(a[0], input, env, ctx)) ctx.debug?.(['DEBUG:', m]); yield input; return; }
    case 'halt/0': throw new HaltError(0);
    case 'halt_error/0': throw new HaltError(5, input);
    case 'halt_error/1': { const c = reqNum(first(evalNode(a[0], input, env, ctx)).value); throw new HaltError(c, input); }
  }
  throw err(`${name}/${args.length} is not defined`);
}

// ── assignment / update (`=`, `|=`, `+=`, …) ────────────────────────────────

function* evalAssign(op: string, pathExpr: Node, valExpr: Node, input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<unknown> {
  const paths = collectPaths(pathExpr, input, env, ctx, evalNode);
  if (op === '=') {
    for (const v of evalNode(valExpr, input, env, ctx)) {
      let out = input;
      for (const p of paths) out = setPath(out, p, v);
      yield out;
    }
    return;
  }
  // update-assign: for each path, recompute
  let out = input;
  for (const p of paths) {
    const cur = getPath(out, p);
    let nv: unknown;
    if (op === '|=') {
      const r = first(evalNode(valExpr, cur, env, ctx));
      if (!r.has) { out = delPaths(out, [p]); continue; }
      nv = r.value;
    } else {
      const r = first(evalNode(valExpr, input, env, ctx));
      const binop = op.slice(0, -1); // strip '='
      nv = H.applyBinop(binop, cur, r.value);
    }
    out = setPath(out, p, nv);
  }
  yield out;
}

// Collect the path arrays a path-expression designates over `input`.
function collectPaths(node: Node, input: unknown, env: Env, ctx: Context, evalNode: EvalFn): unknown[][] {
  const out: unknown[][] = [];
  for (const p of evalPaths(node, [], input, env, ctx, evalNode)) out.push(p);
  return out;
}

/** `path(f)` — stream the path arrays the filter `f` designates over `input`. */
function* pathExpr(node: Node, input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<unknown[]> {
  yield* evalPaths(node, [], input, env, ctx, evalNode);
}

/** `input` — pull the next value from the input stream, or error if exhausted. */
function pullInput(ctx: Context): unknown {
  const it = ctx.inputs;
  if (!it) throw err('No more inputs');
  const n = it.next();
  if (n.done) throw err('No more inputs');
  return n.value;
}

/** `inputs` — yield all remaining values from the input stream. */
function* pullInputs(ctx: Context): Generator<unknown> {
  const it = ctx.inputs;
  if (!it) return;
  for (;;) { const n = it.next(); if (n.done) return; yield n.value; }
}

// Yield the paths reached by a filter (path expression) from `input`.
function* evalPaths(node: Node, prefix: unknown[], input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<unknown[]> {
  switch (node.kind) {
    case 'identity': yield prefix; return;
    case 'recurseDefault': { for (const p of recursePaths(input, prefix)) yield p; return; }
    case 'pipe': {
      for (const lp of evalPaths(node.left, prefix, input, env, ctx, evalNode)) {
        const sub = getPath(input, lp.slice(prefix.length));
        for (const rp of evalPaths(node.right, lp, sub, env, ctx, evalNode)) yield rp;
      }
      return;
    }
    case 'comma':
      yield* evalPaths(node.left, prefix, input, env, ctx, evalNode);
      yield* evalPaths(node.right, prefix, input, env, ctx, evalNode);
      return;
    case 'index': {
      const base = getPathFromRoot(node.target, prefix, input, env, ctx, evalNode);
      for (const { path, value } of base) {
        for (const idx of evalNode(node.index, input, env, ctx)) {
          void value;
          yield [...path, idx];
        }
      }
      return;
    }
    case 'iterate': {
      const base = getPathFromRoot(node.target, prefix, input, env, ctx, evalNode);
      for (const { path, value } of base) {
        if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield [...path, i]; }
        else if (value && typeof value === 'object') { for (const k of Object.keys(value)) yield [...path, k]; }
        else if (value === null) { /* nothing */ }
        else throw err(`Cannot iterate over ${typeOf(value)}`);
      }
      return;
    }
    case 'optional': { try { yield* evalPaths(node.body, prefix, input, env, ctx, evalNode); } catch (e) { if (!isCatchable(e)) throw e; } return; }
    case 'call': {
      if (node.name === 'select' && node.args.length === 1) {
        for (const c of evalNode(node.args[0], input, env, ctx)) if (truthy(c)) yield prefix;
        return;
      }
      if (node.name === 'getpath' && node.args.length === 1) {
        for (const p of evalNode(node.args[0], input, env, ctx)) yield [...prefix, ...(p as unknown[])];
        return;
      }
      if (node.name === 'first' && node.args.length === 1) {
        for (const p of evalPaths(node.args[0], prefix, input, env, ctx, evalNode)) { yield p; return; }
        return;
      }
      if (node.name === 'last' && node.args.length === 1) {
        let lastP: unknown[] | null = null;
        for (const p of evalPaths(node.args[0], prefix, input, env, ctx, evalNode)) lastP = p;
        if (lastP) yield lastP;
        return;
      }
      break;
    }
  }
  throw err('Invalid path expression');
}

// Resolve a path-expr to {path, value} pairs starting from prefix/input root.
function* getPathFromRoot(node: Node, prefix: unknown[], input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<{ path: unknown[]; value: unknown }> {
  for (const p of evalPaths(node, prefix, input, env, ctx, evalNode)) {
    yield { path: p, value: getPath(input, p.slice(prefix.length)) };
  }
}

function* recursePaths(v: unknown, prefix: unknown[]): Generator<unknown[]> {
  yield prefix;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) yield* recursePaths(v[i], [...prefix, i]); }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) yield* recursePaths((v as Record<string, unknown>)[k], [...prefix, k]); }
}

// ── recurse with filter ─────────────────────────────────────────────────────

function* recurseF(f: Node, cond: Node | null, input: unknown, env: Env, ctx: Context, evalNode: EvalFn): Generator<unknown> {
  if (cond) { let ok = false; for (const c of evalNode(cond, input, env, ctx)) if (truthy(c)) ok = true; if (!ok) return; }
  yield input;
  for (const next of evalNode(f, input, env, ctx)) {
    try { yield* recurseF(f, cond, next, env, ctx, evalNode); }
    catch (e) { if (!isCatchable(e)) throw e; }
  }
}

function walk(input: unknown, f: Node, env: Env, ctx: Context, evalNode: EvalFn): unknown {
  let v: unknown = input;
  if (Array.isArray(input)) v = input.map((e) => walk(e, f, env, ctx, evalNode));
  else if (input && typeof input === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(input as object)) o[k] = walk(val, f, env, ctx, evalNode);
    v = o;
  }
  return first(evalNode(f, v, env, ctx)).value;
}

function* combinations(arrs: unknown[], i: number, acc: unknown[]): Generator<unknown> {
  if (i >= (arrs as unknown[]).length) { yield [...acc]; return; }
  const cur = (arrs as unknown[][])[i];
  for (const x of cur) yield* combinations(arrs, i + 1, [...acc, x]);
}

// ── value utilities ─────────────────────────────────────────────────────────

function first(gen: Iterable<unknown>): { has: boolean; value: unknown } {
  for (const v of gen) return { has: true, value: v };
  return { has: false, value: undefined };
}

function* iter(v: unknown): Generator<unknown> {
  if (Array.isArray(v)) yield* v;
  else if (v && typeof v === 'object') yield* Object.values(v as object);
  else throw err(`Cannot iterate over ${typeOf(v)} (${toStr(v)})`);
}

function lengthOf(v: unknown): number {
  const t = typeOf(v);
  if (t === 'null') return 0;
  if (t === 'boolean') throw err(`boolean (${v}) has no length`);
  if (t === 'number') return Math.abs(v as number);
  if (t === 'string') return Array.from(v as string).length;
  if (t === 'array') return (v as unknown[]).length;
  return Object.keys(v as object).length;
}

function keysOf(v: unknown, sort: boolean): unknown[] {
  if (Array.isArray(v)) return v.map((_e, i) => i);
  if (v && typeof v === 'object') { const k = Object.keys(v); return sort ? k.sort() : k; }
  throw err(`${typeOf(v)} (${toStr(v)}) has no keys`);
}

function hasKey(container: unknown, key: unknown): boolean {
  if (Array.isArray(container)) { if (typeof key !== 'number') throw err('Cannot check whether array has a string key'); return key >= 0 && key < container.length; }
  if (container && typeof container === 'object') { if (typeof key !== 'string') throw err('has() key must be a string for objects'); return Object.prototype.hasOwnProperty.call(container, key); }
  throw err(`Cannot check whether ${typeOf(container)} has a key`);
}

function containsVal(a: unknown, b: unknown): boolean {
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) return equal(a, b);
  if (ta === 'object') { for (const k of Object.keys(b as object)) { if (!Object.prototype.hasOwnProperty.call(a, k)) return false; if (!containsVal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false; } return true; }
  if (ta === 'array') return (b as unknown[]).every((be) => (a as unknown[]).some((ae) => containsVal(ae, be)));
  if (ta === 'string') return (a as string).includes(b as string);
  return equal(a, b);
}

function addAll(v: unknown): unknown {
  const items = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v as object) : (v === null ? [] : null));
  if (items === null) throw err(`Cannot iterate over ${typeOf(v)}`);
  if (items.length === 0) return null;
  return items.reduce((acc, x) => H.applyBinop('+', acc, x), null as unknown);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); if (isNaN(n) && v.trim() !== 'NaN') throw err(`Cannot parse '${v}' as number`); return n; }
  throw err(`Cannot parse ${typeOf(v)} as number`);
}

function reqStr(v: unknown): string { if (typeof v !== 'string') throw err(`${typeOf(v)} (${toStr(v)}) cannot be matched, as it is not a string`); return v; }
/** Case-fold ONLY ASCII letters A-Z/a-z (jq's ascii_upcase/ascii_downcase). */
function asciiCase(s: string, upper: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (upper && c >= 0x61 && c <= 0x7a) out += String.fromCharCode(c - 0x20);
    else if (!upper && c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + 0x20);
    else out += s[i];
  }
  return out;
}
function reqStrArg(v: unknown): string { if (typeof v !== 'string') throw err('expected string argument'); return v; }
function reqNum(v: unknown): number { if (typeof v !== 'number') throw err(`${typeOf(v)} (${toStr(v)}) number required`); return v; }

function reverseOf(v: unknown): unknown {
  if (Array.isArray(v)) return [...v].reverse();
  if (typeof v === 'string') return Array.from(v).reverse().join('');
  if (v === null) return null;
  throw err(`Cannot reverse ${typeOf(v)}`);
}

function sortArr(v: unknown): unknown[] { if (!Array.isArray(v)) throw err(`${typeOf(v)} (${toStr(v)}) cannot be sorted, as it is not an array`); return [...v].sort(compare); }

function uniqueArr(v: unknown): unknown[] {
  const s = sortArr(v);
  const out: unknown[] = [];
  for (const x of s) if (out.length === 0 || !equal(out[out.length - 1], x)) out.push(x);
  return out;
}

function flatten(v: unknown, depth: number): unknown[] {
  if (!Array.isArray(v)) throw err(`Cannot flatten ${typeOf(v)}`);
  const out: unknown[] = [];
  const go = (arr: unknown[], d: number): void => {
    for (const x of arr) { if (Array.isArray(x) && d > 0) go(x, d - 1); else out.push(x); }
  };
  go(v, depth);
  return out;
}

/** `transpose` — turn rows into columns, padding short rows with null. */
function transpose(v: unknown): unknown[][] {
  if (!Array.isArray(v)) throw err(`Cannot transpose ${typeOf(v)}`);
  let cols = 0;
  for (const row of v) { if (!Array.isArray(row)) throw err('transpose: input must be an array of arrays'); if (row.length > cols) cols = row.length; }
  const out: unknown[][] = [];
  for (let c = 0; c < cols; c++) {
    const col: unknown[] = [];
    for (const row of v) col.push((row as unknown[])[c] ?? null);
    out.push(col);
  }
  return out;
}

function extremum(v: unknown, dir: number): unknown {
  if (!Array.isArray(v)) throw err(`Cannot compute min/max of ${typeOf(v)}`);
  if (v.length === 0) return null;
  return v.reduce((best, x) => (compare(x, best) * dir > 0 ? x : best));
}

function joinArr(v: unknown, sep: unknown): string {
  if (!Array.isArray(v)) throw err(`Cannot join ${typeOf(v)}`);
  const s = typeof sep === 'string' ? sep : toStr(sep);
  return v.map((e) => (e === null ? '' : (typeof e === 'string' ? e : (typeof e === 'number' || typeof e === 'boolean' ? toStr(e) : (() => { throw err(`Cannot join with ${typeOf(e)}`); })())))).join(s);
}

function splitStr(v: unknown, sep: unknown): string[] {
  if (typeof v !== 'string') throw err('split input and separator must be strings');
  if (typeof sep !== 'string') throw err('split separator must be a string');
  if (sep === '') return v === '' ? [] : Array.from(v);
  return v.split(sep);
}

function toEntries(v: unknown): unknown[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err('to_entries requires an object');
  return Object.entries(v).map(([k, val]) => ({ key: k, value: val }));
}

function fromEntries(v: unknown): Record<string, unknown> {
  if (!Array.isArray(v)) throw err('from_entries requires an array');
  const out: Record<string, unknown> = {};
  for (const e of v) {
    const o = e as Record<string, unknown>;
    const key = o.key ?? o.k ?? o.name ?? o.Name ?? o.K ?? o.Key;
    let val: unknown = 'value' in o ? o.value : ('v' in o ? o.v : ('Value' in o ? o.Value : null));
    if (val === undefined) val = null;
    const ks = key === null || key === undefined ? 'null' : (typeof key === 'string' ? key : toStr(key));
    out[ks] = val;
  }
  return out;
}

function getPath(v: unknown, path: unknown[]): unknown {
  let cur = v;
  for (const key of path) { if (cur === null || cur === undefined) return null; cur = H.indexValue(cur, key); }
  return cur ?? null;
}

function setPath(v: unknown, path: unknown[], val: unknown): unknown {
  if (path.length === 0) return val;
  const [key, ...rest] = path;
  if (typeof key === 'number') {
    const arr = Array.isArray(v) ? [...v] : (v === null ? [] : (() => { throw err(`Cannot index ${typeOf(v)} with number`); })());
    const idx = key < 0 ? arr.length + key : key;
    while (arr.length <= idx) arr.push(null);
    arr[idx] = setPath(arr[idx] ?? null, rest, val);
    return arr;
  }
  if (typeof key === 'string') {
    const obj = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...v as object } as Record<string, unknown> : (v === null ? {} : (() => { throw err(`Cannot index ${typeOf(v)} with "${key}"`); })());
    obj[key] = setPath(obj[key] ?? null, rest, val);
    return obj;
  }
  if (key && typeof key === 'object' && !Array.isArray(key)) {
    // slice setpath {start,end} — rare; minimal support
    throw err('Cannot setpath with object key');
  }
  throw err(`Invalid path key ${typeOf(key)}`);
}

function delPaths(v: unknown, paths: unknown[][]): unknown {
  // delete deepest/last first to keep indices valid
  const sorted = [...paths].sort((a, b) => compare(b, a));
  let out = v;
  for (const p of sorted) out = delOne(out, p);
  return out;
}

function delOne(v: unknown, path: unknown[]): unknown {
  if (path.length === 0) return v;
  if (v === null || v === undefined) return v;
  const [key, ...rest] = path;
  if (rest.length === 0) {
    if (Array.isArray(v)) { const arr = [...v]; const idx = (key as number) < 0 ? arr.length + (key as number) : key as number; if (idx >= 0 && idx < arr.length) arr.splice(idx, 1); return arr; }
    if (typeof v === 'object') { const o = { ...v as object } as Record<string, unknown>; delete o[key as string]; return o; }
    throw err(`Cannot delete field of ${typeOf(v)}`);
  }
  if (Array.isArray(v)) { const arr = [...v]; const idx = (key as number) < 0 ? arr.length + (key as number) : key as number; if (idx >= 0 && idx < arr.length) arr[idx] = delOne(arr[idx], rest); return arr; }
  if (typeof v === 'object') { const o = { ...v as object } as Record<string, unknown>; if (key as string in o) o[key as string] = delOne(o[key as string], rest); return o; }
  return v;
}

function leafPaths(v: unknown): unknown[][] {
  const out: unknown[][] = [];
  for (const p of recursePaths(v, [])) {
    if (p.length === 0) continue;
    const val = getPath(v, p);
    if (!Array.isArray(val) && (val === null || typeof val !== 'object')) out.push(p);
  }
  return out;
}

function* allPaths(v: unknown): Generator<unknown[]> { yield* recursePaths(v, []); }

function* toStream(v: unknown): Generator<unknown> {
  // simplified tostream: [path, leaf] pairs + closing markers
  for (const p of recursePaths(v, [])) {
    const val = getPath(v, p);
    if (!Array.isArray(val) && (val === null || typeof val !== 'object')) yield [p, val];
  }
}

function indicesGeneric(input: unknown, needle: unknown): number[] {
  if (typeof input === 'string' && typeof needle === 'string') {
    const out: number[] = []; if (needle === '') return out;
    let i = input.indexOf(needle); while (i >= 0) { out.push(i); i = input.indexOf(needle, i + 1); } return out;
  }
  if (Array.isArray(input)) {
    const out: number[] = [];
    if (Array.isArray(needle)) { for (let i = 0; i + needle.length <= input.length; i++) { let ok = needle.length > 0; for (let j = 0; j < needle.length; j++) if (!equal(input[i + j], needle[j])) { ok = false; break; } if (ok) out.push(i); } return out; }
    input.forEach((e, i) => { if (equal(e, needle)) out.push(i); });
    return out;
  }
  if (input === null) return [];
  throw err(`Cannot compute indices of ${typeOf(input)}`);
}

function sortByKey(v: unknown, key: Node, env: Env, ctx: Context, evalNode: EvalFn): unknown[] {
  if (!Array.isArray(v)) throw err(`Cannot sort ${typeOf(v)}`);
  const keyed = v.map((e) => ({ e, k: [...evalNode(key, e, env, ctx)] }));
  keyed.sort((x, y) => compare(x.k, y.k));
  return keyed.map((x) => x.e);
}

function groupByKey(v: unknown, key: Node, env: Env, ctx: Context, evalNode: EvalFn): unknown[][] {
  if (!Array.isArray(v)) throw err(`Cannot group ${typeOf(v)}`);
  const keyed = v.map((e) => ({ e, k: first(evalNode(key, e, env, ctx)).value }));
  keyed.sort((x, y) => compare(x.k, y.k));
  const out: unknown[][] = [];
  let curKey: unknown; let cur: unknown[] | null = null;
  for (const { e, k } of keyed) {
    if (cur === null || !equal(k, curKey)) { cur = []; out.push(cur); curKey = k; }
    cur.push(e);
  }
  return out;
}

function uniqueByKey(v: unknown, key: Node, env: Env, ctx: Context, evalNode: EvalFn): unknown[] {
  if (!Array.isArray(v)) throw err(`Cannot unique ${typeOf(v)}`);
  const keyed = v.map((e) => ({ e, k: first(evalNode(key, e, env, ctx)).value }));
  keyed.sort((x, y) => compare(x.k, y.k));
  const out: unknown[] = []; let lastK: unknown; let has = false;
  for (const { e, k } of keyed) { if (!has || !equal(k, lastK)) { out.push(e); lastK = k; has = true; } }
  return out;
}

function extremumBy(v: unknown, key: Node, env: Env, ctx: Context, evalNode: EvalFn, dir: number): unknown {
  if (!Array.isArray(v)) throw err(`Cannot compute min_by/max_by of ${typeOf(v)}`);
  if (v.length === 0) return null;
  let best = v[0]; let bestK = first(evalNode(key, v[0], env, ctx)).value;
  for (let i = 1; i < v.length; i++) {
    const k = first(evalNode(key, v[i], env, ctx)).value;
    // max_by keeps the LAST max on ties; min_by keeps the FIRST min.
    if (compare(k, bestK) * dir > 0 || (dir > 0 && compare(k, bestK) === 0)) { best = v[i]; bestK = k; }
  }
  return best;
}

function* rangeGen(lo: number, hi: number, step: number): Generator<number> {
  if (step === 0) return;
  if (step > 0) { for (let i = lo; i < hi; i += step) yield i; }
  else { for (let i = lo; i > hi; i += step) yield i; }
}

// ── regex (using JS RegExp; jq uses Oniguruma but flags map closely) ─────────

function jqFlags(fl: string | undefined): { g: boolean; flags: string } {
  let flags = '';
  let g = false;
  for (const c of fl ?? '') {
    if (c === 'g') g = true;
    else if (c === 'i') flags += 'i';
    else if (c === 'x') { /* extended: not supported, ignore */ }
    else if (c === 's') flags += 's';
    else if (c === 'm') flags += 'm';
    else if (c === 'n') { /* ignore empty matches: best effort */ }
    else if (c === 'p') flags += 'sm';
    else if (c === 'l' || c === 'g') { /* */ }
  }
  return { g, flags };
}

function compileRe(re: unknown, fl: string | undefined, extraGlobal = false): RegExp {
  if (typeof re !== 'string') {
    if (Array.isArray(re)) return compileRe(re[0], (re[1] as string) ?? fl, extraGlobal);
    throw err('regex must be a string');
  }
  const { g, flags } = jqFlags(fl);
  return new RegExp(re, flags + ((g || extraGlobal) ? 'g' : '') + 'd');
}

function regexTest(input: unknown, re: unknown, fl: string | undefined): boolean {
  const s = reqStr(input);
  return compileRe(re, fl).test(s);
}

interface MatchObj { offset: number; length: number; string: string; captures: Array<{ offset: number; length: number; string: string | null; name: string | null }>; }

function regexMatch(input: unknown, re: unknown, fl: string | undefined): MatchObj[] {
  const s = reqStr(input);
  const rx = compileRe(re, fl, true);
  const out: MatchObj[] = [];
  const { g } = jqFlags(fl);
  for (const m of s.matchAll(rx)) {
    const groups = m.indices ? m.indices.slice(1) : [];
    const names = m.groups ? Object.keys(m.groups) : [];
    const captures = (m.slice(1) as (string | undefined)[]).map((cap, i) => {
      const span = groups[i];
      return { offset: span ? span[0] : -1, length: cap == null ? 0 : cap.length, string: cap ?? null, name: names[i] ?? null };
    });
    out.push({ offset: m.index!, length: m[0].length, string: m[0], captures });
    if (!g) break;
  }
  return out;
}

function regexCapture(input: unknown, re: unknown, fl: string | undefined): Record<string, unknown> {
  const ms = regexMatch(input, re, fl);
  const out: Record<string, unknown> = {};
  if (ms.length) for (const c of ms[0].captures) if (c.name) out[c.name] = c.string;
  return out;
}

/**
 * `scan` — yield every (global) match of `re` in the input string. With no
 * capture groups each output is the whole match string; with groups each output
 * is the array of group captures (jq semantics).
 */
function regexScan(input: unknown, re: unknown, fl: string | undefined): unknown[] {
  const s = reqStr(input);
  const rx = compileRe(re, fl, true);
  const out: unknown[] = [];
  for (const m of s.matchAll(rx)) {
    if (m.length > 1) out.push((m.slice(1) as (string | undefined)[]).map((g) => g ?? null));
    else out.push(m[0]);
    if (m[0] === '') rx.lastIndex++; // avoid infinite loop on empty match
  }
  return out;
}

/**
 * `sub`/`gsub`: replace matches of `re` in the input string. The replacement
 * `repNode` is a FILTER evaluated with each match's named-capture object as its
 * input (so `.name`, `\(.name)`, etc. work). A replacement filter that yields
 * multiple strings produces multiple result strings (cartesian over matches),
 * matching jq's streaming semantics.
 */
function* regexSub(input: unknown, re: unknown, repNode: Node, fl: string | undefined, global: boolean, env: Env, ctx: Context, evalNode: EvalFn): Generator<string> {
  const s = reqStr(input);
  const rx = compileRe(re, fl, true);
  const matches: RegExpMatchArray[] = [];
  for (const m of s.matchAll(rx)) {
    matches.push(m);
    if (!global) break;
    if (m[0] === '') rx.lastIndex++; // avoid infinite loop on empty match
  }
  // Build the capture object for a match (named captures only, like `capture`).
  const capObj = (m: RegExpMatchArray): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    if (m.groups) for (const [k, v] of Object.entries(m.groups)) o[k] = v ?? null;
    return o;
  };
  // Recursively assemble the output, expanding each match's replacement stream.
  yield* build(0, 0, '');
  function* build(mi: number, last: number, acc: string): Generator<string> {
    if (mi >= matches.length) { yield acc + s.slice(last); return; }
    const m = matches[mi];
    const start = m.index!;
    const between = acc + s.slice(last, start);
    for (const rep of evalNode(repNode, capObj(m), env, ctx)) {
      if (typeof rep !== 'string') throw err(`${typeOf(rep)} (${toStr(rep)}) cannot be used as a sub/gsub replacement`);
      yield* build(mi + 1, start + m[0].length, between + rep);
    }
  }
}

/** Split a string on a REGEX (used by `splits/1`, `splits/2`, `split/2`). */
function* regexSplit(input: unknown, re: unknown, fl: string | undefined): Generator<string> {
  const s = reqStr(input);
  const rx = compileRe(re, fl, true);
  let last = 0;
  for (const m of s.matchAll(rx)) {
    if (m[0] === '') { rx.lastIndex++; continue; } // skip empty matches (avoid infinite splits)
    yield s.slice(last, m.index!);
    last = m.index! + m[0].length;
  }
  yield s.slice(last);
}

// ── @format encoders ─────────────────────────────────────────────────────────

/**
 * `@uri` percent-encoding matching jq: only the RFC 3986 *unreserved* set
 * (`A-Za-z0-9` and `-_.~`) passes through; everything else — including
 * `! * ' ( )`, which `encodeURIComponent` leaves alone — is percent-encoded
 * byte-by-byte over the UTF-8 encoding.
 */
function uriEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) {
    const unreserved =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e; // - _ . ~
    out += unreserved ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin);
}
function base64Decode(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('utf-8');
  const bin = atob(s); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes);
}
function csvCell(v: unknown): string {
  if (v === null) return '';
  if (typeof v === 'number') return toStr(v);
  if (typeof v === 'boolean') return toStr(v);
  if (typeof v === 'string') return '"' + v.replace(/"/g, '""') + '"';
  throw err('Not valid in a csv row');
}
function tsvCell(v: unknown): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return toStr(v);
  if (typeof v === 'string') return v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  throw err('Not valid in a tsv row');
}
function rowFormat(v: unknown, sep: string, cell: (v: unknown) => string): string {
  if (!Array.isArray(v)) throw err('@csv/@tsv input must be an array');
  return v.map(cell).join(sep);
}
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}
function shFormat(v: unknown): string {
  const q = (x: unknown): string => { if (typeof x === 'string') return '\'' + x.replace(/'/g, '\'\\\'\'') + '\''; if (typeof x === 'number' || typeof x === 'boolean') return toStr(x); throw err(`Cannot escape ${typeOf(x)} for shell`); };
  if (Array.isArray(v)) return v.map(q).join(' ');
  return q(v);
}

export type { JQType };
