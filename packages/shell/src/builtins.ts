/**
 * Shell builtins — commands that run in-process (no spawn), mutating shell
 * state (cwd, env, functions, jobs) and/or writing to the current stdout/stderr.
 */

import { shellQuoteBackslash } from './quote.ts';
import { interpretEscapes } from './escape.ts';
import { parseIfs } from './expander.ts';
import type { IfsSpec } from './expander.ts';

/** Richer shell state surface a few builtins need (functions, jobs, positionals). */
export interface ShellState {
  functions: Map<string, { name: string; body: unknown }>;
  jobs: Array<{ id: number; pids: number[]; command: string; state: string; exitCode?: number }>;
  positional: string[];
  setPositional(p: string[]): void;
  shiftPositional(n: number): void;
  /**
   * Mark a name as local to the current function scope. Returns:
   *   'fresh'    — a function scope exists and this call FIRST shadowed the name
   *                (a prior global value is now hidden; `+=` should start empty).
   *   'existing' — a function scope exists and the name was ALREADY local here.
   *   'none'     — at the top level (no-op); lets `local` error and `declare` fall
   *                back to global scope.
   */
  declareLocal(name: string): 'fresh' | 'existing' | 'none';
  /** Register a name as an associative array (`declare -A`). */
  declareAssoc?(name: string): void;
  /**
   * Set an indexed array variable (`read -a` / `mapfile`). Reuses the same
   * storage the `name=(a b c)` assignment path writes, so the values are visible
   * to `${name[i]}` / `${name[@]}` / `${#name[@]}` expansion.
   */
  setArray?(name: string, values: string[]): void;
  /** Wait for a job/pid, returning its exit code. */
  waitJob(spec?: number): Promise<number>;
  waitAll(): Promise<number>;
  /** `wait -n`: wait for the NEXT job to finish; resolves 127 when none exist. */
  waitNext?(): Promise<number>;
  /** Toggle `set -e` errexit. */
  setErrExit(v: boolean): void;
  /** Set a shell option by its long name (errexit, nounset, xtrace, pipefail, noclobber). */
  setOption(name: ShellOptionName, value: boolean): void;
  /** Read a shell option's current value. */
  getOption(name: ShellOptionName): boolean;
  /** All options as [longName, enabled] pairs in canonical order. */
  listOptions(): Array<[ShellOptionName, boolean]>;
  /** Set a `shopt` option (extglob/globstar/...). Returns false for an unknown name. */
  setShopt?(name: string, value: boolean): boolean;
  /** Read a `shopt` option's value (undefined ⇒ unknown name). */
  getShopt?(name: string): boolean | undefined;
  /** Register/remove a trap handler. signal name (EXIT/ERR/INT/...) → handler ('' clears). */
  setTrap?(signal: string, handler: string | undefined): void;
  /** List traps as [signal, handler] pairs. */
  listTraps?(): Array<[string, string]>;
  /** History: append a line, list, or clear. */
  history?: {
    list(): string[];
    add(line: string): void;
    clear(): void;
  };
  /** Remove a job from the table by spec (pid or %id). Returns false if not found. */
  removeJob?(spec: number): boolean;
  /** Send a signal to a job/pid. Returns false if no such job. */
  killJob?(spec: number, signal: string): boolean;
  /** Mark a name as `readonly` (reassignment is then rejected). */
  markReadonly?(name: string): void;
  /** True when the name was marked `readonly`. */
  isReadonly?(name: string): boolean;
  /**
   * `unset NAME` — fully remove a variable: scalar value, indexed/associative
   * array, and its attributes (integer/nameref). `unset NAME[idx]` removes a
   * single element (numeric index for an indexed array, string key for assoc).
   */
  unsetVar?(name: string, index?: string): void;
  /** Mark a name as integer (`declare -i`): assignments are arithmetic-evaluated. */
  markInteger?(name: string): void;
  /** True when the name was marked integer (`declare -i`). */
  isInteger?(name: string): boolean;
  /**
   * `declare -p [names]` reconstruction. With no names, every set variable/array.
   * Returns the `declare …` lines and any requested names that were not found.
   */
  declareP?(names: string[]): { lines: string[]; missing: string[] };
  /** Record a `declare -n ref=target` nameref (single-level). */
  setNameref?(ref: string, target: string): void;
  /** Resolve a nameref to its target (single-level), or undefined if not a nameref. */
  resolveNameref?(name: string): string | undefined;
  /**
   * Set a variable at GLOBAL scope (`declare -g NAME=v`). Even when a same-name
   * local shadows it in the current/enclosing frame, the global binding is updated
   * so it is visible after those frames return — while the live local value is left
   * untouched. Returns true if a shadowing local exists (caller must NOT also write
   * the flat env), false if it wrote the global directly.
   */
  setGlobal?(name: string, value: string): boolean;
  /**
   * The directory stack BELOW the current directory (`pushd`/`popd`/`dirs`),
   * most-recent-first. The live array — `dirs`/`pushd`/`popd` mutate it in place.
   * The current directory (`ctx.cwd`) is the conceptual top and is NOT stored here.
   */
  dirStack?(): string[];
}

/** Shell reserved words, for `type`/`type -t`/`command -v` classification (`keyword`). */
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done',
  'for', 'select', 'in', 'case', 'esac', 'function', 'time', '{', '}', '!', '[[', ']]', 'coproc',
]);

/** True when `name` is a shell reserved word. */
export function isShellKeyword(name: string): boolean {
  return SHELL_KEYWORDS.has(name);
}

/** Long names of the shell options toggled via `set` / `set -o`. */
export type ShellOptionName =
  | 'errexit' | 'nounset' | 'xtrace' | 'pipefail' | 'noclobber' | 'verbose' | 'posix'
  | 'histexpand';

/** `set -o`-settable option names in canonical (sorted) order — drives $SHELLOPTS. */
export const SET_O_OPTIONS: ShellOptionName[] = [
  'errexit', 'histexpand', 'noclobber', 'nounset', 'pipefail', 'posix', 'verbose', 'xtrace',
];

/** Map of `set -X` short flags ↔ long option names. */
export const OPTION_FLAGS: Record<string, ShellOptionName> = {
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  v: 'verbose',
  C: 'noclobber',
  H: 'histexpand',
};

/**
 * `shopt`-settable bash options (sorted) — drives $BASHOPTS. The expander/glob
 * consults extglob/globstar/nullglob/dotglob/nocaseglob/nocasematch.
 */
export const SHOPT_NAMES: string[] = [
  'dotglob', 'extglob', 'globstar', 'nocaseglob', 'nocasematch', 'nullglob',
];

/** Mutable shell state + I/O hooks a builtin operates on. */
export interface BuiltinContext {
  cwd: string;
  env: Record<string, string>;
  write(s: string): void;
  /** Write raw bytes to stdout without a UTF-8 round-trip (binary-safe `cat`). */
  writeBytes?(b: Uint8Array): void;
  writeErr?(s: string): void;
  exit?(code: number): void;
  eval?(src: string): Promise<number>;
  /** `source FILE args` — read FILE from the VFS and run it in the current shell. */
  sourceFile?(args: string[]): Promise<number>;
  /**
   * Read one line from a numbered fd (for `read -u N`); undefined ⇒ EOF/closed.
   * May be async — a live `/dev/tcp` (`<>`) fd reads from the socket on demand.
   */
  readFdLine?(fd: number): string | undefined | Promise<string | undefined>;
  /**
   * Mark the line returned by the most recent {@link readFdLine} on `fd` as
   * consumed (for a live duplex fd). `read` calls this once it uses the line so
   * the next read fetches a fresh one; on a `read -t` timeout it is NOT called,
   * leaving the in-flight read available to the next reader (no data dropped).
   */
  consumeFdLine?(fd: number): void;
  /**
   * Read one line of PLAIN stdin (no `-u`) from the frame's shared stdin reader,
   * racing `timeoutSec` (for `read -t`). `timedOut` true ⇒ the timer won (the var
   * is left empty and `read` returns >128); the reader retains any pulled bytes
   * for the next read (no data dropped).
   */
  readStdinLine?(timeoutSec?: number): Promise<{ line: string | undefined; timedOut: boolean }>;
  /**
   * A numbered fd that stdin (fd 0) has been ALIASED to by a `<&N` input-dup
   * redirect (`read <&3`) — set only when fd 0's entry carries a live `duplex`
   * (e.g. `/dev/udp`) or buffered `input`. When present and no explicit `-u` was
   * given, `read` sources from THIS fd (via {@link readFdLine}) instead of the
   * plain-stdin frame reader, so `read … <&3` reads fd 3's datagram/line. The
   * `-t` timeout applies to that path exactly as it does for `read -u N`.
   */
  stdinFd?: number;
  /** Slurp ALL remaining stdin bytes (binary-safe) — for `mapfile`. */
  readStdinAll?(): Promise<Uint8Array>;
  /**
   * Stream remaining stdin bytes to `sink` chunk-by-chunk (binary-exact, no full
   * buffering) — for a streaming `cat`. Does not slurp; a bare `cat` over a large
   * or never-EOF stream emits as it reads instead of buffering to EOF.
   */
  readStdinPump?(sink: (chunk: Uint8Array) => void | Promise<void>): Promise<void>;
  /**
   * Read a delimited/counted chunk of stdin for `read -d`/`-n`/`-N`. `ignoreDelim`
   * (`-N`) reads exactly `max` chars ignoring the delimiter; otherwise reads up to
   * `delim` (default `\n`) or `max` chars, whichever comes first. `undefined` ⇒ EOF.
   */
  readStdinChunk?(delim: string | undefined, max: number | undefined, ignoreDelim: boolean): Promise<string | undefined>;
  lastStatus?: number;
  stdin?: ReadableStream<Uint8Array>;
  /** Loop/function control — implemented by the executor as thrown unwinds. */
  doBreak?(n: number): never;
  doContinue?(n: number): never;
  doReturn?(n: number): never;
  /**
   * Evaluate a single arithmetic expression over the live shell env (assignments
   * mutate the env), returning its integer value — backs the `let` builtin.
   * Implemented by the executor over the same env proxy `(( ))` uses.
   */
  evalArith?(expr: string): bigint;
  /**
   * Resolve a command NAME to its `$PATH` executable path (or an explicit path) —
   * backs `type`/`command -v`'s file reporting. Returns the resolved absolute path
   * or undefined (not found / no VFS). May be async (the FsClient stat is async).
   */
  resolveExternal?(name: string): string | undefined | Promise<string | undefined>;
  /**
   * Structured assignment operands for an ASSIGNMENT BUILTIN (`declare`/`local`/
   * `readonly`/`export`/`typeset`), parsed by the parser as assignment words so an
   * array literal `declare -a arr=(a b c)` arrives as an Assignment with an `array`
   * field. The builtin marks the flag attributes (`-A`/`-i`/`-r`, `declareLocal`)
   * for the name, then applies the array/assoc/index/append value via
   * {@link applyBuiltinAssignment}. Scalar `NAME=v` operands also appear here but
   * are still applied by the builtin's own string path.
   */
  builtinAssignments?: BuiltinAssignment[];
  /**
   * Apply an ARRAY / ASSOC / INDEXED / APPEND assignment operand (from
   * {@link builtinAssignments}) to the live shell state via the executor's shared
   * assignment path — after the builtin has marked the name's flag attributes.
   * Returns true if rejected (e.g. readonly). Scalars are applied by the builtin.
   */
  applyBuiltinAssignment?(a: BuiltinAssignment): Promise<boolean>;
  /** Richer state for local/declare/shift/getopts/jobs/wait. */
  state?: ShellState;
}

/** A structured assignment operand handed to an assignment builtin (see BuiltinContext). */
export interface BuiltinAssignment {
  name: string;
  value: string;
  array?: string[];
  index?: string;
  append?: boolean;
}

export const BUILTINS = [
  'cd', 'pwd', 'export', 'unset', 'echo', 'printf',
  'test', '[', 'true', 'false', 'exit', 'eval', 'set', 'cat', ':',
  'local', 'declare', 'typeset', 'readonly', 'let', 'shift', 'return', 'getopts', 'read',
  'mapfile', 'readarray',
  'jobs', 'fg', 'bg', 'wait', 'kill', 'break', 'continue', 'source', '.', 'type',
  'shopt', 'trap', 'disown', 'history', 'fc', 'exec', 'coproc',
  'dirs', 'pushd', 'popd', 'hash', 'command', 'builtin',
  'compgen', 'complete', 'compopt',
] as const;

const BUILTIN_SET = new Set<string>(BUILTINS);

export function isBuiltin(name: string): boolean {
  return BUILTIN_SET.has(name);
}

/** POSIX 2.8.1 special builtins — an error here is FATAL to a non-interactive shell in POSIX mode. */
export const POSIX_SPECIAL_BUILTINS: ReadonlySet<string> = new Set([
  ':', '.', 'break', 'continue', 'eval', 'exec', 'exit',
  'export', 'readonly', 'return', 'set', 'shift', 'trap', 'unset',
]);

/** Thrown by a special builtin on a fatal error in POSIX mode; the executor aborts the script. */
export class PosixSpecialBuiltinError extends Error {
  readonly builtin: string;
  readonly code: number;
  constructor(builtin: string, code: number, message: string) {
    super(message);
    this.name = 'PosixSpecialBuiltinError';
    this.builtin = builtin;
    this.code = code;
  }
}

function errOut(ctx: BuiltinContext, s: string): void {
  (ctx.writeErr ?? ctx.write)(s);
}

function resolvePath(cwd: string, target: string): string {
  const base = target.startsWith('/') ? '' : cwd;
  const combined = `${base}/${target}`;
  const parts = combined.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { stack.pop(); continue; }
    stack.push(part);
  }
  return '/' + stack.join('/');
}

/**
 * Format the directory stack for `dirs`/`pushd`/`popd`: cwd first, then the
 * `below` entries (most-recent-first), space-separated. Unless `long`, abbreviate
 * a leading `$HOME` to `~` (bash default).
 */
function formatDirStack(cwd: string, below: string[], long: boolean, home: string | undefined): string {
  const abbrev = (p: string): string => {
    if (long || home === undefined || home === '') return p;
    if (p === home) return '~';
    if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
    return p;
  };
  return [cwd, ...below].map(abbrev).join(' ');
}

/**
 * Resolve a `+N`/`-N` dir-stack token to a 0-based index into the full list
 * (`[cwd, ...stack]`). `+N` counts from the LEFT, `-N` from the RIGHT
 * (`-0` = last). Returns undefined if out of range.
 */
function rotIndex(token: string, len: number): number | undefined {
  const n = parseInt(token.slice(1), 10);
  const idx = token[0] === '+' ? n : len - 1 - n;
  return idx >= 0 && idx < len ? idx : undefined;
}

export async function runBuiltin(name: string, args: string[], ctx: BuiltinContext): Promise<number> {
  switch (name) {
    case ':':
    case 'true':
      return 0;

    case 'false':
      return 1;

    case 'cd': {
      const target = args[0] ?? ctx.env.HOME ?? '/';
      ctx.cwd = resolvePath(ctx.cwd, target);
      ctx.env.PWD = ctx.cwd;
      return 0;
    }

    case 'pwd':
      ctx.write(ctx.cwd + '\n');
      return 0;

    case 'dirs': {
      const stack = ctx.state?.dirStack?.();
      if (stack === undefined) { errOut(ctx, 'shell: dirs: directory stack not available\n'); return 1; }
      if (args.includes('-c')) { stack.length = 0; return 0; }
      const long = args.includes('-l');
      ctx.write(formatDirStack(ctx.cwd, stack, long, ctx.env.HOME) + '\n');
      return 0;
    }

    case 'pushd': {
      const stack = ctx.state?.dirStack?.();
      if (stack === undefined) { errOut(ctx, 'shell: pushd: directory stack not available\n'); return 1; }
      // `pushd +N`/`-N` rotates the full list `[cwd, ...stack]` so its Nth entry
      // becomes the new top (`+` from the left, `-` from the right).
      const rot = args.find((a) => /^[+-]\d+$/.test(a));
      if (rot !== undefined) {
        const full = [ctx.cwd, ...stack];
        const idx = rotIndex(rot, full.length);
        if (idx === undefined) { errOut(ctx, `shell: pushd: ${rot}: directory stack index out of range\n`); return 1; }
        const rotated = full.slice(idx).concat(full.slice(0, idx));
        ctx.cwd = rotated[0];
        ctx.env.PWD = ctx.cwd;
        stack.length = 0;
        stack.push(...rotated.slice(1));
        ctx.write(formatDirStack(ctx.cwd, stack, false, ctx.env.HOME) + '\n');
        return 0;
      }
      const dir = args.find((a) => !a.startsWith('-') && !/^[+-]\d+$/.test(a));
      if (dir === undefined) {
        // No argument: swap the top two entries (cwd ↔ stack top).
        if (stack.length === 0) { errOut(ctx, 'shell: pushd: no other directory\n'); return 1; }
        const prevCwd = ctx.cwd;
        ctx.cwd = stack[0];
        ctx.env.PWD = ctx.cwd;
        stack[0] = prevCwd;
      } else {
        // Push cwd below, then cd to DIR (DIR becomes the new top = cwd).
        stack.unshift(ctx.cwd);
        ctx.cwd = resolvePath(ctx.cwd, dir);
        ctx.env.PWD = ctx.cwd;
      }
      ctx.write(formatDirStack(ctx.cwd, stack, false, ctx.env.HOME) + '\n');
      return 0;
    }

    case 'popd': {
      const stack = ctx.state?.dirStack?.();
      if (stack === undefined) { errOut(ctx, 'shell: popd: directory stack not available\n'); return 1; }
      if (stack.length === 0) { errOut(ctx, 'shell: popd: directory stack empty\n'); return 1; }
      // `popd +N`/`-N` removes the Nth entry of the full list `[cwd, ...stack]`
      // (`+0` removes cwd → the next entry becomes cwd).
      const rot = args.find((a) => /^[+-]\d+$/.test(a));
      if (rot !== undefined) {
        const full = [ctx.cwd, ...stack];
        const idx = rotIndex(rot, full.length);
        if (idx === undefined) { errOut(ctx, `shell: popd: ${rot}: directory stack index out of range\n`); return 1; }
        full.splice(idx, 1);
        ctx.cwd = full[0];
        ctx.env.PWD = ctx.cwd;
        stack.length = 0;
        stack.push(...full.slice(1));
        ctx.write(formatDirStack(ctx.cwd, stack, false, ctx.env.HOME) + '\n');
        return 0;
      }
      ctx.cwd = stack.shift()!;
      ctx.env.PWD = ctx.cwd;
      ctx.write(formatDirStack(ctx.cwd, stack, false, ctx.env.HOME) + '\n');
      return 0;
    }

    case 'echo': {
      let newline = true;
      let interpret = false;
      let start = 0;
      // In POSIX mode, `echo` does NOT recognise `-n`/`-e` flags (they are
      // printed literally) — matches the reference's posix/xpg_echo behavior.
      const posix = ctx.state?.getOption('posix') ?? false;
      while (!posix && start < args.length && /^-[neE]+$/.test(args[start])) {
        if (args[start].includes('n')) newline = false;
        if (args[start].includes('e')) interpret = true;
        if (args[start].includes('E')) interpret = false;
        start++;
      }
      let s = args.slice(start).join(' ');
      // `echo -e` interprets the full backslash-escape set (octal `\0NN`/`\NNN`,
      // hex `\xHH`, `\e`/`\a`/`\b`/`\f`/`\v`/`\t`/`\n`/`\r`/`\\`) so ANSI/OSC
      // sequences in a sourced .bashrc render — shared with printf via the helper.
      if (interpret) s = interpretEscapes(s, /*octalBackslashZero*/ true);
      ctx.write(s + (newline ? '\n' : ''));
      return 0;
    }

    case 'printf': {
      const r = formatPrintf(args[0] ?? '', args.slice(1));
      ctx.write(r.out);
      for (const e of r.errors) errOut(ctx, `shell: printf: ${e}\n`);
      return r.errors.length > 0 ? 1 : 0;
    }

    case 'export': {
      let status = 0;
      // `export arr=(a b c)` creates the (non-exported) array via the shared
      // assignment path, matching bash (an array cannot be exported, but the
      // variable is still created).
      for (const a of ctx.builtinAssignments ?? []) {
        if (a.array === undefined) continue;
        if (ctx.state?.isReadonly?.(a.name)) {
          errOut(ctx, `shell: export: ${a.name}: readonly variable\n`);
          status = 1;
        } else if (await ctx.applyBuiltinAssignment?.(a)) {
          status = 1;
        }
      }
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq > 0) {
          const n = arg.slice(0, eq);
          if (ctx.state?.isReadonly?.(n)) {
            errOut(ctx, `shell: export: ${n}: readonly variable\n`);
            status = 1;
            continue;
          }
          ctx.env[n] = arg.slice(eq + 1);
        }
      }
      return status;
    }

    case 'unset': {
      let status = 0;
      // `-v` (variable) / `-f` (function) selectors; default is variable-then-function.
      const onlyFunc = args[0] === '-f';
      const names = (args[0] === '-v' || args[0] === '-f') ? args.slice(1) : args;
      for (const arg of names) {
        // Split an `name[idx]` element form.
        const mm = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/s.exec(arg);
        const base = mm ? mm[1] : arg;
        const index = mm ? mm[2] : undefined;
        // A readonly variable cannot be unset (bash: `unset: <name>: cannot unset:
        // readonly variable`, status 1). Functions are unaffected by readonly.
        if (!onlyFunc && ctx.state?.isReadonly?.(base)) {
          errOut(ctx, `shell: unset: ${base}: cannot unset: readonly variable\n`);
          status = 1;
          continue;
        }
        if (onlyFunc) { ctx.state?.functions.delete(base); continue; }
        // Remove the scalar + array/assoc storage + attributes (or one element).
        delete ctx.env[base];
        ctx.state?.unsetVar?.(base, index);
        if (index === undefined) ctx.state?.functions.delete(base);
      }
      return status;
    }

    case 'local':
    case 'declare':
    case 'typeset':
    case 'readonly': {
      // `typeset` is a ksh-compat synonym for `declare`.
      const isLocal = name === 'local';
      const isReadonly = name === 'readonly';
      const isDeclare = name === 'declare' || name === 'typeset';
      // Collect flag LETTERS from every leading `-…` token, so combined flags like
      // `declare -ar` / `local -ri` / `declare -Ax` work the same as `-a -r`.
      // Only tokens before the first non-flag operand are options (bash); a bare
      // `-` or `+…` is not a flag token here.
      const flags = new Set<string>();
      for (const a of args) {
        if (a.length > 1 && a[0] === '-') { for (const ch of a.slice(1)) flags.add(ch); }
        else break; // first operand — stop flag scanning
      }
      const isAssoc = (isDeclare || isLocal) && flags.has('A');
      // `declare -n ref=target` / `local -n ref=target` declares a nameref (single-
      // level): reads of `ref` and writes to `ref` are redirected to `target` (the
      // latter in the executor's applyAssignment). Recorded, not stored as a value.
      const isNameref = (isDeclare || isLocal) && flags.has('n');
      // `declare -p [name...]` prints the declare reconstruction (no assignment).
      if (isDeclare && flags.has('p')) {
        const names = args.filter((x) => !x.startsWith('-'));
        const out = ctx.state?.declareP?.(names);
        if (out === undefined) return 0;
        if (out.missing.length > 0) { for (const mn of out.missing) errOut(ctx, `shell: declare: ${mn}: not found\n`); }
        for (const line of out.lines) ctx.write(line + '\n');
        return out.missing.length > 0 ? 1 : 0;
      }
      // Scoping: `local` is always function-local (and errors outside a function).
      // A bare `declare`/`typeset` inside a function is LOCAL by default; `-g` forces
      // GLOBAL. `readonly`/`export` are always global. `scopeLocal` requests the
      // function-local snapshot for the name; falls back to global at the top level.
      const flagGlobal = flags.has('g');
      const scopeLocal = isLocal || (isDeclare && !flagGlobal);
      // `declare -i` / `-r` attributes (also honored on `local`). `readonly` is
      // always the readonly attribute; a `-i` on any of them marks integer.
      const flagInteger = flags.has('i');
      const flagReadonly = isReadonly || flags.has('r');
      if (isAssoc && (ctx.state?.getOption('posix') ?? false)) {
        errOut(ctx, 'shell: declare: -A: not supported in POSIX mode\n');
        return 2;
      }
      let declStatus = 0;
      // Structured ARRAY-LITERAL operands (`declare -a arr=(a b c)`, parsed as
      // assignment words by the parser): mark the name's flag attributes in bash
      // order (assoc BEFORE element writes so they land in the assoc map, integer
      // before value eval, local before assign), then apply the array via the
      // executor's shared assignment path. Scalar/element operands stay plain args
      // handled by the string loop below.
      for (const a of ctx.builtinAssignments ?? []) {
        if (a.array === undefined) continue;
        // Local-scope the name FIRST (snapshot for restore) so a function-local
        // `declare`/`local`/`typeset` array does not leak to the caller; then the
        // attribute markers and value application below act on the local.
        if (scopeLocal) {
          const scope = ctx.state?.declareLocal(a.name) ?? 'none';
          if (isLocal && scope === 'none') { errOut(ctx, 'shell: local: can only be used in a function\n'); return 1; }
        }
        if (isAssoc) ctx.state?.declareAssoc?.(a.name);
        if (flagInteger) ctx.state?.markInteger?.(a.name);
        if (ctx.state?.isReadonly?.(a.name)) {
          errOut(ctx, `shell: ${name}: ${a.name}: readonly variable\n`);
          declStatus = 1;
        } else if (await ctx.applyBuiltinAssignment?.(a)) {
          declStatus = 1;
        }
        if (flagReadonly) ctx.state?.markReadonly?.(a.name);
      }
      for (const arg of args) {
        if (arg.startsWith('-')) continue; // option flags handled above
        const eq = arg.indexOf('=');
        const rawName = eq > 0 ? arg.slice(0, eq) : arg;
        // Strip an `+=` append marker and any `[subscript]` for the attribute name
        // (so `declare -i n+=` / `declare -r a[0]=` mark the base name `n`/`a`).
        const append = rawName.endsWith('+');
        const n = (append ? rawName.slice(0, -1) : rawName).replace(/\[.*\]$/, '');
        if (isNameref) {
          // `declare -n ref=target` / `local -n ref=target`: record the mapping (no
          // literal value stored). A bare `declare -n`/`local -n` in a function is
          // local-by-default, so scope it first (the executor snapshots+restores the
          // nameref mapping on return); `-g` keeps it global.
          if (scopeLocal) {
            const scope = ctx.state?.declareLocal(n) ?? 'none';
            if (isLocal && scope === 'none') { errOut(ctx, 'shell: local: can only be used in a function\n'); return 1; }
          }
          if (eq > 0) ctx.state?.setNameref?.(n, arg.slice(eq + 1));
          continue;
        }
        // Function scoping FIRST (bash: `declare`/`typeset`/`local` shadow the global
        // as a local before assigning). A bare `declare` inside a function is local;
        // `-g`/`readonly`/`export` are global. `local` outside a function is an error.
        let freshLocal = false;
        if (scopeLocal) {
          const scope = ctx.state?.declareLocal(n) ?? 'none';
          if (isLocal && scope === 'none') { errOut(ctx, 'shell: local: can only be used in a function\n'); return 1; }
          // A FRESH local shadows the outer variable with an EMPTY value: `local x`
          // hides a global `x` (`${x}` is empty inside), and `local x+=v` appends to
          // '' not the shadowed global. An ALREADY-local name keeps its current local
          // value (so `local -i c=3; local -i c+=2` → 5). The array/assoc storage was
          // already snapshotted+cleared conceptually via declareLocal's snapshot; we
          // clear the scalar here.
          freshLocal = scope === 'fresh';
          if (freshLocal) delete ctx.env[n];
        }
        // `declare -A name` registers an associative array (G6).
        if (isAssoc) ctx.state?.declareAssoc?.(n);
        // `declare -i name` marks the name integer BEFORE assigning, so the RHS
        // is arithmetic-evaluated (bash: `declare -i n=1+2` → n=3).
        if (flagInteger) ctx.state?.markInteger?.(n);
        if (eq > 0) {
          // A write to an ALREADY-readonly var fails — even via `readonly NAME=val`
          // (bash: `readonly r=a; readonly r=b` errors). The first `readonly RO=1`
          // succeeds because RO isn't readonly YET (it is marked below). A failure
          // sets the exit status but CONTINUES to the remaining names (bash: a
          // multi-name `readonly a b c` still assigns the non-readonly ones).
          if (ctx.state?.isReadonly?.(n)) {
            errOut(ctx, `shell: ${name}: ${n}: readonly variable\n`);
            declStatus = 1;
            continue;
          }
          if (!isAssoc) {
            const rhs = arg.slice(eq + 1);
            const prev = append ? (ctx.env[n] ?? '') : '';
            const val = flagInteger
              ? String(append ? (ctx.evalArith?.(prev || '0') ?? 0n) + (ctx.evalArith?.(rhs) ?? 0n) : (ctx.evalArith?.(rhs) ?? 0n))
              : prev + rhs; // `+=` appends (prev is '' when not append)
            // `declare -g` writes the GLOBAL binding (updating an enclosing local's
            // snapshot rather than clobbering it); otherwise write the current env.
            if (flagGlobal && ctx.state?.setGlobal?.(n, val)) { /* global updated */ }
            else ctx.env[n] = val;
          }
        }
        // A bare `declare NAME` / `local NAME` (no `=value`) declares the name but
        // leaves it UNSET (bash: `local x; echo ${x+SET}` prints nothing) — a fresh
        // local was already cleared by declareLocal, so nothing to write here.
        // `readonly`/`-r` mark the name AFTER its value is set, so the builtin's
        // own assignment succeeds; later reassignments are rejected by the
        // executor's applyAssignment (POSIX-fatal in posix mode).
        if (flagReadonly) ctx.state?.markReadonly?.(n);
      }
      return declStatus;
    }

    case 'let': {
      // Evaluate each arithmetic expression over the live env (assignments take).
      // Exit status mirrors bash: 1 when the LAST expression evaluates to 0, else
      // 0. No expressions → status 1. A malformed expression / division by zero is
      // a per-command error (status 2 + diagnostic), NOT a script abort.
      if (args.length === 0) return 1;
      let last = 0n;
      try {
        for (const expr of args) last = ctx.evalArith?.(expr) ?? 0n;
      } catch (e) {
        errOut(ctx, `shell: let: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
      return last === 0n ? 1 : 0;
    }

    case 'shift': {
      const n = args[0] !== undefined ? (parseInt(args[0], 10) || 0) : 1;
      ctx.state?.shiftPositional(n);
      return 0;
    }

    case 'return': {
      const code = args[0] !== undefined ? (parseInt(args[0], 10) || 0) : (ctx.lastStatus ?? 0);
      if (ctx.doReturn) ctx.doReturn(code);
      return code;
    }

    case 'break': {
      const n = args[0] !== undefined ? (parseInt(args[0], 10) || 1) : 1;
      if (ctx.doBreak) ctx.doBreak(n);
      return 0;
    }

    case 'continue': {
      const n = args[0] !== undefined ? (parseInt(args[0], 10) || 1) : 1;
      if (ctx.doContinue) ctx.doContinue(n);
      return 0;
    }

    case 'getopts': {
      return runGetopts(args, ctx);
    }

    case 'read': {
      return await runRead(args, ctx);
    }

    case 'mapfile':
    case 'readarray': {
      return await runMapfile(args, ctx);
    }

    case 'set':
      return runSet(args, ctx);

    case 'cat': {
      // Stream stdin chunk-by-chunk (binary-exact, no full buffering) so a bare
      // `cat` over a large/never-EOF stream emits as it reads. Fall back to a
      // one-shot slurp for a ctx without the pump hook (older test harnesses).
      if (ctx.readStdinPump) {
        await ctx.readStdinPump((chunk) => {
          if (chunk.byteLength === 0) return;
          if (ctx.writeBytes) ctx.writeBytes(chunk);
          else ctx.write(new TextDecoder().decode(chunk));
        });
        return 0;
      }
      const all = await (ctx.readStdinAll?.() ?? Promise.resolve(new Uint8Array()));
      if (all.byteLength > 0) {
        if (ctx.writeBytes) ctx.writeBytes(all);
        else ctx.write(new TextDecoder().decode(all));
      }
      return 0;
    }

    case 'jobs': {
      const jobs = ctx.state?.jobs ?? [];
      for (const j of jobs) {
        const sym = j.state === 'running' ? 'Running' : j.state === 'stopped' ? 'Stopped' : 'Done';
        ctx.write(`[${j.id}]  ${sym}\t${j.command}\n`);
      }
      return 0;
    }

    case 'fg':
    case 'bg': {
      // No TTY/job-control suspension in this runtime; fg waits for the job,
      // bg is a no-op acknowledgement. Honest limitation (see executor docs).
      const jobs = ctx.state?.jobs ?? [];
      if (jobs.length === 0) { errOut(ctx, `shell: ${name}: no current job\n`); return 1; }
      if (name === 'fg') {
        const spec = parseJobSpec(args[0]);
        return (await ctx.state?.waitJob(spec)) ?? 0;
      }
      return 0;
    }

    case 'wait': {
      if (!ctx.state) return 0;
      // `wait -n` — wait for the NEXT job to finish (G5). With no jobs, 127.
      if (args.includes('-n')) {
        if (!ctx.state.waitNext) return 127;
        return ctx.state.waitNext();
      }
      if (args.length === 0) return ctx.state.waitAll();
      let last = 0;
      for (const a of args) {
        const spec = parseJobSpec(a);
        // `wait %N`/`wait pid` for a job that does not exist → 127 (M17).
        if (a.startsWith('%') && spec !== undefined && !jobExists(ctx, spec)) {
          errOut(ctx, `shell: wait: ${a}: no such job\n`);
          return 127;
        }
        last = await ctx.state.waitJob(spec);
      }
      return last;
    }

    case 'kill': {
      // No args → usage. `%N`/pid honors the job table; unknown → no such job (M14).
      const sigArgs = args.filter((a) => !a.startsWith('-'));
      if (args.length === 0) {
        errOut(ctx, 'shell: kill: usage: kill [-signal] pid|%job ...\n');
        return 1;
      }
      let signal = 'TERM';
      for (const a of args) {
        if (a.startsWith('-') && a.length > 1) signal = normalizeSignal(a.slice(1));
      }
      let status = 0;
      for (const a of sigArgs) {
        const spec = parseJobSpec(a);
        if (spec === undefined || !ctx.state?.killJob || !ctx.state.killJob(spec, signal)) {
          errOut(ctx, `shell: kill: ${a}: no such job\n`);
          status = 1;
        }
      }
      return status;
    }

    case 'type': {
      // Flags (may be CLUSTERED, e.g. -ta): -t (type word), -a (all locations),
      // -p (path, only when not shadowed), -P (force PATH search), -f (suppress
      // function lookup). `--` ends option processing.
      let flagT = false, flagA = false, flagP = false, flagBigP = false, flagF = false;
      const names: string[] = [];
      let noMoreOpts = false;
      for (const a of args) {
        if (!noMoreOpts && a === '--') { noMoreOpts = true; continue; }
        if (!noMoreOpts && a.length > 1 && a[0] === '-') {
          let bad = '';
          for (const ch of a.slice(1)) {
            if (ch === 't') flagT = true;
            else if (ch === 'a') flagA = true;
            else if (ch === 'p') flagP = true;
            else if (ch === 'P') flagBigP = true;
            else if (ch === 'f') flagF = true;
            else { bad = ch; break; }
          }
          if (bad !== '') { errOut(ctx, `shell: type: -${bad}: invalid option\n`); return 2; }
          continue;
        }
        names.push(a);
      }
      let status = 0;
      for (const nm of names) {
        const isKeyword = SHELL_KEYWORDS.has(nm);
        const isFunc = !flagF && (ctx.state?.functions.has(nm) ?? false);
        const isBn = isBuiltin(nm);
        // -P forces a PATH search even when a builtin/keyword/function shadows the
        // name. Otherwise resolve a file only when needed (`-a`, or unshadowed).
        const shadowed = isKeyword || isFunc || isBn;
        const wantFile = flagBigP || flagA || !shadowed;
        const file = wantFile ? await ctx.resolveExternal?.(nm) : undefined;
        if (!shadowed && file === undefined) {
          // -t / -p / -P print nothing for an unknown name (silent); default warns.
          if (!flagT && !flagP && !flagBigP) errOut(ctx, `type: ${nm}: not found\n`);
          status = 1; continue;
        }
        if (flagP || flagBigP) {
          // Path forms: print ONLY the file path (nothing for a shadowed name under
          // -p; -P prints the forced PATH hit). A miss exits 1: for -p only when the
          // name is NOT shadowed (a shadowed builtin has rc 0), but for -P (force
          // search) ALWAYS — `type -P if` finds no file and exits 1 (bash).
          if (file !== undefined) ctx.write(`${file}\n`);
          else if (flagBigP || !shadowed) status = 1;
          continue;
        }
        if (flagT) {
          // `-t` prints the type WORD. With `-a` it lists one per location (bash
          // order: keyword, function, builtin, file); without `-a`, only the first.
          if (flagA) {
            if (isKeyword) ctx.write('keyword\n');
            if (isFunc) ctx.write('function\n');
            if (isBn) ctx.write('builtin\n');
            if (file !== undefined) ctx.write('file\n');
          } else {
            ctx.write(`${isKeyword ? 'keyword' : isFunc ? 'function' : isBn ? 'builtin' : 'file'}\n`);
          }
          continue;
        }
        // Default / -a: emit in bash order — keyword, function, builtin, then file.
        // Without -a only the first (highest-priority) location is printed.
        if (isKeyword) { ctx.write(`${nm} is a shell keyword\n`); if (!flagA) continue; }
        if (isFunc) { ctx.write(`${nm} is a function\n`); if (!flagA) continue; }
        if (isBn) { ctx.write(`${nm} is a shell builtin\n`); if (!flagA) continue; }
        if (file !== undefined) ctx.write(`${nm} is ${file}\n`);
      }
      return status;
    }

    case 'command':
    case 'builtin': {
      // The executor intercepts `command`/`builtin CMD …` before dispatch (to
      // bypass functions); reaching here means a pipeline stage or a no-arg call.
      // Best-effort: run the target through eval (functions not bypassed here).
      let rest = args;
      if (name === 'command') {
        // Parse leading option flags, which may be CLUSTERED (`-vp`, `-Vp`, `-pv`).
        let dashV = false, dashBigV = false;
        while (rest.length > 0 && rest[0].length > 1 && rest[0][0] === '-' && rest[0] !== '--') {
          let bad = '';
          for (const ch of rest[0].slice(1)) {
            if (ch === 'v') dashV = true;
            else if (ch === 'V') dashBigV = true;
            else if (ch === 'p') { /* default-PATH search: accepted, no-op here */ }
            else { bad = ch; break; }
          }
          if (bad !== '') break; // unknown flag → treat as the command word (bash-ish)
          rest = rest.slice(1);
        }
        if (rest[0] === '--') rest = rest.slice(1);
        if (dashV || dashBigV) {
          const bigV = dashBigV;
          const t = rest[0];
          if (t !== undefined) {
            if (isShellKeyword(t)) { ctx.write(bigV ? `${t} is a shell keyword\n` : `${t}\n`); return 0; }
            if (ctx.state?.functions.has(t)) { ctx.write(bigV ? `${t} is a function\n` : `${t}\n`); return 0; }
            if (isBuiltin(t)) { ctx.write(bigV ? `${t} is a shell builtin\n` : `${t}\n`); return 0; }
            const p = await ctx.resolveExternal?.(t);
            if (p !== undefined) { ctx.write(bigV ? `${t} is ${p}\n` : `${p}\n`); return 0; }
            if (bigV) errOut(ctx, `shell: command: ${t}: not found\n`);
          }
          return 1;
        }
      }
      if (rest.length === 0) return 0;
      if (name === 'builtin' && !isBuiltin(rest[0])) { errOut(ctx, `shell: builtin: ${rest[0]}: not a shell builtin\n`); return 1; }
      return ctx.eval ? await ctx.eval(rest.join(' ')) : 0;
    }

    case 'source':
    case '.': {
      // In POSIX mode only `.` is valid; `source` is a bash extension.
      if (name === 'source' && (ctx.state?.getOption('posix') ?? false)) {
        errOut(ctx, 'shell: source: not supported in POSIX mode (use . instead)\n');
        return 1;
      }
      // The executor wires a file-aware source via ctx.sourceFile; fall back to
      // treating args as an inline script for eval when unavailable.
      if (ctx.sourceFile) return ctx.sourceFile(args);
      if (ctx.eval) return ctx.eval(args.join(' '));
      return 0;
    }

    case 'exec':
      // `exec REDIR` (no command) is intercepted by the executor to install
      // persistent fds. `exec cmd` cannot replace the process in this sandbox;
      // we run it as a normal command via eval, best-effort.
      if (args.length === 0) return 0;
      if (ctx.eval) return ctx.eval(args.join(' '));
      return 0;

    case 'coproc':
      // A2: `coproc` is a reserved word handled by the parser/executor (see
      // Executor.execCoproc). Reaching the builtin means it was used as a plain
      // word in a context the grammar did not route — emit the precise
      // backend-gating diagnostic rather than the old blanket "not supported".
      errOut(ctx, 'shell: coproc: requires a transferable backend\n');
      return 1;

    case 'hash': {
      // No PATH hash table exists in the sandbox (commands resolve fresh on every
      // spawn via resolveCommand / exec-from-VFS), so `hash` is inert — but scripts
      // call it and expect success. Accept the documented option surface and return
      // 0; reject an unknown flag like bash (status 2).
      // Flags may be CLUSTERED (e.g. `-lr`, `-dt`), so validate each letter of a
      // `-…` token against the allowed set rather than matching the whole token.
      const allowed = 'lrpdt';
      for (const a of args) {
        if (a.startsWith('-') && a !== '-') {
          for (const ch of a.slice(1)) {
            if (!allowed.includes(ch)) {
              errOut(ctx, `shell: hash: ${a}: invalid option\nhash: usage: hash [-lr] [-p pathname] [-dt] [name ...]\n`);
              return 2;
            }
          }
        }
      }
      return 0;
    }

    case 'complete':
    case 'compopt':
      // Interactive completion specs — there is no line editor in the sandbox, so
      // these register/modify nothing. Accept and ignore (exit 0, no output).
      return 0;

    case 'compgen': {
      // `compgen -W WORDLIST [PREFIX]` filters a wordlist by prefix — the one form
      // with non-interactive value (usable in scripts). Other actions (-A/-c/-f …)
      // have no source in the sandbox → exit 1 (honest "no matches").
      const wIdx = args.indexOf('-W');
      if (wIdx >= 0 && args[wIdx + 1] !== undefined) {
        const words = args[wIdx + 1].split(/\s+/).filter((w) => w !== '');
        // The prefix is the trailing operand after the wordlist. Honor an explicit
        // `--` end-of-options marker: when present, the prefix is the first token
        // AFTER `--` (so even a leading-dash prefix is taken literally). Otherwise
        // fall back to the first non-option token after the wordlist.
        const tail = args.slice(wIdx + 2);
        const ddIdx = tail.indexOf('--');
        const prefix = ddIdx >= 0
          ? (tail[ddIdx + 1] ?? '')
          : (tail.find((a) => !a.startsWith('-')) ?? '');
        const matches = words.filter((w) => w.startsWith(prefix));
        for (const m of matches) ctx.write(m + '\n');
        return matches.length > 0 ? 0 : 1;
      }
      return 1;
    }

    case 'shopt':
      return runShopt(args, ctx);

    case 'trap':
      return runTrap(args, ctx);

    case 'disown': {
      if (!ctx.state?.removeJob) return 0;
      let status = 0;
      for (const a of args) {
        if (a.startsWith('-')) continue;
        const spec = parseJobSpec(a);
        if (spec === undefined || !ctx.state.removeJob(spec)) {
          errOut(ctx, `shell: disown: ${a}: no such job\n`);
          status = 1;
        }
      }
      return status;
    }

    case 'history':
      return runHistory(args, ctx);

    case 'fc': {
      // `fc -l` lists recent history (the only form we support).
      if (args.includes('-l') && ctx.state?.history) {
        const lines = ctx.state.history.list();
        const n = lines.length;
        const startIdx = Math.max(0, n - 16);
        for (let k = startIdx; k < n; k++) ctx.write(`${k + 1}\t${lines[k]}\n`);
      }
      return 0;
    }

    case 'test':
    case '[': {
      let a = args;
      if (name === '[') {
        if (a[a.length - 1] !== ']') { errOut(ctx, 'shell: [: missing `]\'\n'); return 2; }
        a = a.slice(0, -1);
      }
      return evalTest(a) ? 0 : 1;
    }

    case 'exit': {
      const code = args.length > 0 ? (parseInt(args[0], 10) || 0) : (ctx.lastStatus ?? 0);
      if (ctx.exit) ctx.exit(code);
      return code;
    }

    case 'eval': {
      const src = args.join(' ');
      if (ctx.eval) return ctx.eval(src);
      return 0;
    }

    default:
      errOut(ctx, `shell: ${name}: not a builtin\n`);
      return 127;
  }
}

function parseJobSpec(arg?: string): number | undefined {
  if (arg === undefined) return undefined;
  if (arg.startsWith('%')) return parseInt(arg.slice(1), 10);
  return parseInt(arg, 10);
}

function jobExists(ctx: BuiltinContext, spec: number): boolean {
  const jobs = ctx.state?.jobs ?? [];
  return jobs.some((j) => j.id === spec || j.pids.includes(spec));
}

/** Map a signal number/name to a canonical name (e.g. `2`/`SIGINT`/`int` → `INT`). */
function normalizeSignal(s: string): string {
  const byNum: Record<string, string> = { '0': 'EXIT', '2': 'INT', '9': 'KILL', '15': 'TERM', '18': 'CONT', '20': 'TSTP' };
  if (/^\d+$/.test(s)) return byNum[s] ?? s;
  return s.toUpperCase().replace(/^SIG/, '');
}

/**
 * `shopt [-s|-u|-q|-p] [name...]` — bash option store (extglob/globstar/...).
 * `-s` set, `-u` unset, `-q` quiet (exit status only), `-p`/none print. With
 * names but no -s/-u, prints/queries status (exit 0 if all on, 1 otherwise).
 */
function runShopt(args: string[], ctx: BuiltinContext): number {
  const st = ctx.state;
  if (!st?.getShopt || !st.setShopt) return 0;
  let mode: 'set' | 'unset' | 'query' = 'query';
  let quiet = false;
  let print = false;
  const names: string[] = [];
  for (const a of args) {
    if (a === '-s') mode = 'set';
    else if (a === '-u') mode = 'unset';
    else if (a === '-q') quiet = true;
    else if (a === '-p') print = true;
    else if (a.startsWith('-')) { errOut(ctx, `shell: shopt: ${a}: invalid option\n`); return 2; }
    else names.push(a);
  }

  const printOne = (n: string): void => {
    const on = st.getShopt!(n);
    ctx.write(`shopt -${on ? 's' : 'u'} ${n}\n`);
  };

  if (mode === 'set' || mode === 'unset') {
    let status = 0;
    for (const n of names) {
      if (!st.setShopt!(n, mode === 'set')) {
        errOut(ctx, `shell: shopt: ${n}: invalid shell option name\n`);
        status = 2;
      }
    }
    return status;
  }

  // query/print mode
  const allNames = SHOPT_NAMES;
  const targets = names.length > 0 ? names : allNames;
  if (print || (names.length === 0 && !quiet)) {
    let status = 0;
    for (const n of targets) {
      const on = st.getShopt!(n);
      if (on === undefined) { errOut(ctx, `shell: shopt: ${n}: invalid shell option name\n`); status = 1; continue; }
      printOne(n);
      if (!on) status = 1;
    }
    return status;
  }
  // names given (query): `shopt NAME` prints "name<TAB>on|off" and exit reflects state.
  let status = 0;
  for (const n of targets) {
    const on = st.getShopt!(n);
    if (on === undefined) { errOut(ctx, `shell: shopt: ${n}: invalid shell option name\n`); status = 1; continue; }
    if (!quiet) ctx.write(`${n}\t${on ? 'on' : 'off'}\n`);
    if (!on) status = 1;
  }
  return status;
}

/**
 * `trap [HANDLER] [SIGNAL...]` — register/list/remove traps. `trap` with no
 * args lists; `trap -` clears all; `trap - SIG` removes one; `trap '' SIG`
 * ignores; otherwise registers HANDLER for each SIGNAL.
 */
function runTrap(args: string[], ctx: BuiltinContext): number {
  const st = ctx.state;
  if (!st?.setTrap || !st.listTraps) return 0;
  if (args.length === 0) {
    for (const [sig, handler] of st.listTraps()) ctx.write(`trap -- '${handler}' ${sig}\n`);
    return 0;
  }
  if (args[0] === '-' && args.length === 1) {
    for (const [sig] of st.listTraps()) st.setTrap(sig, undefined);
    return 0;
  }
  if (args[0] === '-') {
    for (const s of args.slice(1)) st.setTrap(normalizeSignal(s), undefined);
    return 0;
  }
  const handler = args[0];
  const signals = args.slice(1);
  if (signals.length === 0) { errOut(ctx, 'shell: trap: usage: trap [-lp] [[arg] signal_spec ...]\n'); return 1; }
  for (const s of signals) st.setTrap(normalizeSignal(s), handler);
  return 0;
}

/** `history [-c]` / `history` — list or clear command history. */
function runHistory(args: string[], ctx: BuiltinContext): number {
  const h = ctx.state?.history;
  if (!h) return 0;
  if (args[0] === '-c') { h.clear(); return 0; }
  const lines = h.list();
  for (let k = 0; k < lines.length; k++) ctx.write(`${String(k + 1).padStart(5)}  ${lines[k]}\n`);
  return 0;
}

/**
 * `set` — toggle shell options and/or set positional params.
 *
 *   set -e/-u/-x/-C  +e/+u/+x/+C   short option flags (errexit, nounset,
 *                                  xtrace, noclobber)
 *   set -o NAME / +o NAME          long option by name (also pipefail)
 *   set -o / set +o                list option states (`+o` as re-settable cmds)
 *   set -- a b c                   replace positional params
 *   set a b c                      replace positional params (no leading dash)
 */
function runSet(args: string[], ctx: BuiltinContext): number {
  const st = ctx.state;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { st?.setPositional(args.slice(i + 1)); return 0; }
    if (arg !== '' && (arg[0] === '-' || arg[0] === '+')) {
      const enable = arg[0] === '-';
      const body = arg.slice(1);
      if (body === 'o' || body === '') {
        // `-o NAME` / `+o NAME`, or bare `-o`/`+o` to list.
        const name = args[i + 1];
        if (name === undefined) { listOptions(ctx, enable); return 0; }
        if (!setLongOption(ctx, name, enable)) {
          return failSet(ctx, `shell: set: ${name}: invalid option name\n`);
        }
        i++; // consumed NAME
        continue;
      }
      // Cluster of short flags, e.g. `-eux`. An `o` within the cluster is the
      // long-option introducer (bash: `set -euo pipefail` == `-e -u -o pipefail`),
      // consuming the FOLLOWING word as the option name.
      let consumedName = false;
      for (const ch of body) {
        if (ch === 'o') {
          const name = args[i + 1];
          if (name === undefined) { listOptions(ctx, enable); return 0; }
          if (!setLongOption(ctx, name, enable)) {
            return failSet(ctx, `shell: set: ${name}: invalid option name\n`);
          }
          consumedName = true;
          continue;
        }
        const long = OPTION_FLAGS[ch];
        if (!long) return failSet(ctx, `shell: set: -${ch}: invalid option\n`);
        st?.setOption(long, enable);
      }
      if (consumedName) i++; // consumed the NAME that followed the cluster
      continue;
    }
    // First non-flag operand: the rest are positional params.
    st?.setPositional(args.slice(i));
    return 0;
  }
  return 0;
}

/**
 * A `set` bad-option failure. In POSIX mode this is a fatal error in a special
 * builtin (POSIX 2.8.1) — throw so the executor aborts the script; otherwise
 * report the diagnostic and return 2 (the prior, non-fatal behavior).
 */
function failSet(ctx: BuiltinContext, message: string): number {
  if (ctx.state?.getOption('posix') ?? false) {
    // The executor prepends `shell: ` when it surfaces a PosixSpecialBuiltinError,
    // so strip the message's own leading `shell: ` to avoid a doubled prefix.
    throw new PosixSpecialBuiltinError('set', 2, message.replace(/\n$/, '').replace(/^shell: /, ''));
  }
  errOut(ctx, message);
  return 2;
}

function setLongOption(ctx: BuiltinContext, name: string, value: boolean): boolean {
  if (!SET_O_OPTIONS.includes(name as ShellOptionName)) return false;
  ctx.state?.setOption(name as ShellOptionName, value);
  return true;
}

function listOptions(ctx: BuiltinContext, dashForm: boolean): void {
  const opts = ctx.state?.listOptions() ?? [];
  for (const [name, on] of opts) {
    // `set -o` prints `name<TAB>on|off`; `set +o` prints re-settable commands.
    if (dashForm) ctx.write(`${name}\t${on ? 'on' : 'off'}\n`);
    else ctx.write(`set ${on ? '-o' : '+o'} ${name}\n`);
  }
}

/** getopts OPTSTRING NAME — POSIX option parser using OPTIND/OPTARG in env. */
function runGetopts(args: string[], ctx: BuiltinContext): number {
  const optstring = args[0] ?? '';
  const varName = args[1] ?? '';
  // getopts writes its NAME variable in several places below; a readonly NAME is
  // rejected up front (status 1, no write) like bash, covering all write sites.
  if (ctx.state?.isReadonly?.(varName)) {
    errOut(ctx, `shell: getopts: ${varName}: readonly variable\n`);
    return 1;
  }
  const params = args.length > 2 ? args.slice(2) : (ctx.state?.positional ?? []);
  let optind = parseInt(ctx.env.OPTIND ?? '1', 10) || 1;

  if (optind > params.length) { ctx.env[varName] = '?'; return 1; }
  const arg = params[optind - 1];
  if (arg === undefined || arg[0] !== '-' || arg === '-') { ctx.env[varName] = '?'; return 1; }
  if (arg === '--') { ctx.env.OPTIND = String(optind + 1); ctx.env[varName] = '?'; return 1; }

  // single-letter cluster handling via OPTPOS
  let pos = parseInt(ctx.env.OPTPOS ?? '1', 10) || 1;
  const opt = arg[pos];
  const idx = optstring.indexOf(opt);
  if (idx < 0) {
    ctx.env[varName] = '?';
    ctx.env.OPTARG = opt;
    pos++;
    if (pos >= arg.length) { optind++; pos = 1; }
    ctx.env.OPTIND = String(optind); ctx.env.OPTPOS = String(pos);
    return 0;
  }
  if (optstring[idx + 1] === ':') {
    // takes an argument
    let optarg: string;
    if (pos + 1 < arg.length) { optarg = arg.slice(pos + 1); optind++; }
    else { optarg = params[optind] ?? ''; optind += 2; }
    ctx.env[varName] = opt;
    ctx.env.OPTARG = optarg;
    ctx.env.OPTIND = String(optind); ctx.env.OPTPOS = '1';
    return 0;
  }
  ctx.env[varName] = opt;
  delete ctx.env.OPTARG;
  pos++;
  if (pos >= arg.length) { optind++; pos = 1; }
  ctx.env.OPTIND = String(optind); ctx.env.OPTPOS = String(pos);
  return 0;
}

/** Exit status bash returns when `read -t` times out: >128, specifically 128 + SIGALRM(14). */
const READ_TIMEOUT_STATUS = 142;

/** A sentinel resolved by the `read -t` timer that loses no information when the read wins. */
const TIMED_OUT = Symbol('read-timeout');

/**
 * A timer that resolves to {@link TIMED_OUT} after `seconds` (fractional, like
 * bash `-t 0.1`), paired with a `cancel()` to clear it so the timer is not left
 * dangling when the read wins the race.
 */
function readTimeout(seconds: number): { promise: Promise<typeof TIMED_OUT>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, seconds * 1000));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * read [-r] [-u FD] [-t T] NAME... — read one line (from stdin or fd FD), split
 * on IFS into NAMEs.
 *
 * `read -t T` (A3 Tier 1): the timeout is honored ONLY on the live path — a
 * `read -u N` over a duplex fd (`exec N<>/dev/tcp/...`), which is an awaited
 * stream — by racing the read against a timer. On timeout the builtin returns
 * bash's read-timeout status ({@link READ_TIMEOUT_STATUS}, 128+SIGALRM) and
 * leaves the target var(s) empty; no data is lost because the executor retains
 * the in-flight `readLine` (see `Executor.readFdLine` / `FdEntry.pendingRead`),
 * so the next `read -u N` still sees a late-arriving line.
 *
 * Tier-1 scope: plain `read -t` over the pre-materialized stdin STRING honors
 * `-t` only trivially — the bytes are already present, so the read returns
 * immediately (it can never block, so the timer never fires). Making `-t`/idle
 * `TMOUT` block-then-time-out on string stdin needs a live `ReadableStream`-
 * backed stdin (Tier 2, deferred to a later stage); it is NOT half-built here.
 */
async function runRead(args: string[], ctx: BuiltinContext): Promise<number> {
  // Parse flags. `-r` raw (no backslash escapes), `-a NAME` split into an array,
  // `-d DELIM` line terminator (empty ⇒ NUL), `-n N` max chars, plus `-u`/`-t`.
  const names: string[] = [];
  let fdArg: number | undefined;
  let timeoutSec: number | undefined;
  let raw = false;
  let arrayName: string | undefined;
  let delim: string | undefined; // undefined ⇒ default '\n'; '' ⇒ NUL
  let maxChars: number | undefined;
  let ignoreDelim = false; // `-N` reads EXACTLY N chars, ignoring the delimiter; `-n` stops at it
  // getopts-style: walk each `-` token char by char so SHORT FLAGS CLUSTER like
  // bash (`-ra name`, `-rn3`, `-rd';'`). `r` is a boolean; `a`/`d`/`n`/`N`/`u`/`t`
  // take an argument from the rest of the token (`-n3`) or the next argv (`-n 3`).
  // `-s` (silent) is a no-op (no TTY); `-p PROMPT` consumes its operand and drops
  // it. Other unknown letters are no-ops. Non-`-` args are variable names.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' ) { names.push(...args.slice(i + 1)); break; }
    if (!a.startsWith('-') || a.length < 2) { names.push(a); continue; }
    let j = 1;
    while (j < a.length) {
      const ch = a[j];
      // For an arg-taking flag: the operand is the rest of THIS token, else the next
      // argv. Either way the token is fully consumed (set j = a.length) so the loop ends.
      const operand = (): string => {
        const v = j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? '');
        j = a.length;
        return v;
      };
      if (ch === 'r') { raw = true; j++; continue; }
      if (ch === 'u') { fdArg = parseInt(operand(), 10); continue; }
      if (ch === 't') { timeoutSec = parseFloat(operand()); continue; }
      if (ch === 'a') { arrayName = operand(); continue; }
      if (ch === 'd') { delim = operand(); continue; }
      if (ch === 'n') { maxChars = parseInt(operand(), 10); continue; }
      if (ch === 'N') { maxChars = parseInt(operand(), 10); ignoreDelim = true; continue; }
      // `-p PROMPT` takes the prompt as its operand (printed to a TTY by bash).
      // The sandbox has no TTY, so consume and drop it — crucially so PROMPT is
      // NOT mistaken for a variable name. `-pPROMPT` and clustered `-sp PROMPT`
      // also work via operand().
      if (ch === 'p') { operand(); continue; }
      if (ch === 's') { j++; continue; } // silent: no terminal echo to suppress — no-op
      j++; // unknown short flag: no-op
    }
  }
  if (timeoutSec !== undefined && Number.isNaN(timeoutSec)) timeoutSec = undefined;
  if (maxChars !== undefined && Number.isNaN(maxChars)) maxChars = undefined;
  // `read <&N` aliased fd 0 to a readable numbered fd (duplex/input) — with no
  // explicit `-u`, source from it via the fd path so `read <&3` reads fd 3.
  if (fdArg === undefined && ctx.stdinFd !== undefined) fdArg = ctx.stdinFd;

  const ifsSpec = parseIfs(ctx.env.IFS);
  const finish = (line: string): number => {
    const cooked = raw ? line : unescapeReadLine(line);
    if (arrayName !== undefined) {
      // `read -a` splits the whole line on IFS into the array (no remainder rule).
      ctx.state?.setArray?.(arrayName, splitReadFields(cooked, ifsSpec));
      return 0;
    }
    assignReadVars(names, cooked, ifsSpec, ctx);
    return 0;
  };

  // `-d`/`-n`/`-N` read a delimited/counted chunk from the frame's shared stdin
  // reader (advancing its one cursor). `-d ''` selects a NUL terminator; a
  // literal delimiter uses its first char. `-N` ignores the delimiter entirely.
  if ((delim !== undefined || maxChars !== undefined) && fdArg === undefined) {
    const term = delim === undefined ? undefined : (delim === '' ? '\0' : delim[0]);
    const chunk = await (ctx.readStdinChunk?.(term, maxChars, ignoreDelim) ?? Promise.resolve(undefined));
    if (chunk === undefined) return 1; // EOF
    return finish(chunk);
  }

  // `read -u N` reads from the numbered fd's buffered input (or, for a live
  // `<>` fd like `/dev/tcp`, from the stream on demand — hence the await).
  if (fdArg !== undefined) {
    const read = Promise.resolve(ctx.readFdLine?.(fdArg));
    let line: string | undefined | typeof TIMED_OUT;
    if (timeoutSec !== undefined) {
      const t = readTimeout(timeoutSec);
      line = await Promise.race([read, t.promise]);
      t.cancel();
    } else {
      line = await read;
    }
    if (line === TIMED_OUT) {
      // Timed out: do NOT consume — the in-flight read stays cached so its line
      // reaches the next reader. Clear the named vars and signal >128.
      if (arrayName !== undefined) ctx.state?.setArray?.(arrayName, []);
      else assignReadVars(names, '', ifsSpec, ctx);
      return READ_TIMEOUT_STATUS;
    }
    ctx.consumeFdLine?.(fdArg); // we used this line; the next read fetches a fresh one
    if (line === undefined) return 1; // EOF or fd not open
    return finish(line);
  }

  // Plain `read` — read the next line from the frame's shared stdin reader
  // (supports `-t` and sequential reads over the byte stream). No reader (no
  // stdin stream) ⇒ EOF.
  if (ctx.readStdinLine) {
    const { line, timedOut } = await ctx.readStdinLine(timeoutSec);
    if (timedOut) {
      if (arrayName !== undefined) ctx.state?.setArray?.(arrayName, []);
      else assignReadVars(names, '', ifsSpec, ctx);
      return READ_TIMEOUT_STATUS;
    }
    if (line === undefined) return 1; // EOF
    return finish(line);
  }

  return 1; // no stdin source
}

/**
 * Plain `read` (no `-r`) treats backslash as an escape: a backslash removes
 * itself and the following char is taken literally (`a\b` → `ab`); a trailing
 * backslash is dropped. This is the line-continuation/quote-removal bash applies
 * before IFS splitting; `read -r` skips it entirely.
 */
function unescapeReadLine(line: string): string {
  if (!line.includes('\\')) return line;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      if (i + 1 < line.length) { out += line[i + 1]; i++; }
      // a trailing backslash is dropped
    } else {
      out += line[i];
    }
  }
  return out;
}

/**
 * Assign a read line's IFS-split fields to NAMEs; the LAST name absorbs the
 * remainder VERBATIM (bash keeps the original text minus leading IFS whitespace,
 * with trailing IFS whitespace stripped — so `IFS=: read a b <<< "x:y:z:w"` gives
 * `b="y:z:w"`). No names → the whole line into `$REPLY`.
 */
function assignReadVars(names: string[], line: string, spec: IfsSpec, ctx: BuiltinContext): void {
  if (names.length === 0) { ctx.env.REPLY = line; return; }
  const { fields, rests } = splitReadWithRests(line, spec, names.length);
  for (let i = 0; i < names.length; i++) {
    if (i === names.length - 1) ctx.env[names[i]] = rests[i] ?? '';
    else ctx.env[names[i]] = fields[i] ?? '';
  }
}

/** Split a `read` line fully on IFS (used by `read -a`). */
function splitReadFields(line: string, spec: IfsSpec): string[] {
  const { fields } = splitReadWithRests(line, spec, Infinity);
  return fields;
}

/**
 * Split a `read` line on IFS, returning both the individual `fields` and, for
 * each field index, the `rest` = the verbatim remaining text starting at that
 * field (leading whitespace already consumed, trailing IFS-whitespace trimmed).
 * `limit` bounds how many leading delimiters are split (the read remainder rule);
 * `Infinity` splits every delimiter.
 */
function splitReadWithRests(line: string, spec: IfsSpec, limit: number): { fields: string[]; rests: string[] } {
  const isWs = (c: string): boolean => spec.ws.includes(c);
  const isNon = (c: string): boolean => spec.nonWs.includes(c);
  const isDelim = (c: string): boolean => isWs(c) || isNon(c);
  const fields: string[] = [];
  const rests: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n && isWs(line[i])) i++;         // skip leading IFS whitespace
  while (i < n) {
    // The verbatim remainder for THIS field: from here to the end, with trailing
    // IFS whitespace trimmed.
    let end = n;
    while (end > i && isWs(line[end - 1])) end--;
    rests.push(line.slice(i, end));
    // Once we've produced `limit` fields, the last one absorbs everything — stop.
    if (fields.length >= limit - 1) { fields.push(line.slice(i, end)); break; }
    // Read one field up to the next delimiter.
    let j = i;
    while (j < n && !isDelim(line[j])) j++;
    fields.push(line.slice(i, j));
    if (j >= n) break;
    // Consume the delimiter run (whitespace + at most one non-whitespace char).
    let sawNonWs = isNon(line[j]);
    j++;
    while (j < n && (isWs(line[j]) || (!sawNonWs && isNon(line[j])))) {
      if (isNon(line[j])) sawNonWs = true;
      j++;
    }
    i = j;
    // A trailing delimiter with nothing after does NOT produce an extra empty
    // field in bash (neither for `read -a` nor for word splitting). So we stop.
  }
  return { fields, rests };
}

/**
 * `mapfile`/`readarray [-t] [-d DELIM] [-u FD] [NAME]` — slurp ALL of stdin (or
 * fd `FD`) and split into the indexed array NAME (default `MAPFILE`). Lines are
 * split on `\n` (or `-d DELIM`); `-t` strips the trailing delimiter from each
 * element. A trailing empty segment after the final delimiter is not stored.
 */
async function runMapfile(args: string[], ctx: BuiltinContext): Promise<number> {
  let strip = false;
  let delim = '\n';
  let fdArg: number | undefined;
  let name = 'MAPFILE';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t') { strip = true; continue; }
    if (a === '-d') { const d = args[++i] ?? ''; delim = d === '' ? '\0' : d[0]; continue; }
    if (a.startsWith('-d') && a.length > 2) { delim = a.slice(2)[0]; continue; }
    if (a === '-u') { fdArg = parseInt(args[++i] ?? '', 10); continue; }
    if (a.startsWith('-u') && a.length > 2) { fdArg = parseInt(a.slice(2), 10); continue; }
    if (a.startsWith('-')) continue; // -O/-s/-n/-c/-C unsupported: ignore
    name = a;
  }

  // Read ALL available input. From a numbered fd, drain successive lines; from
  // plain stdin, slurp the frame's shared stdin reader to EOF.
  let data: string;
  if (fdArg !== undefined) {
    const parts: string[] = [];
    for (;;) {
      const line = await Promise.resolve(ctx.readFdLine?.(fdArg));
      if (line === undefined) break;
      ctx.consumeFdLine?.(fdArg);
      parts.push(line.endsWith('\n') ? line : line + '\n');
    }
    data = parts.join('');
  } else {
    const all = await (ctx.readStdinAll?.() ?? Promise.resolve(new Uint8Array()));
    data = new TextDecoder().decode(all);
  }

  const elements = splitKeepingDelimiter(data, delim);
  const values = strip ? elements.map((e) => (e.endsWith(delim) ? e.slice(0, -delim.length) : e)) : elements;
  ctx.state?.setArray?.(name, values);
  return 0;
}

/**
 * Split `data` on `delim` into records, each KEEPING its trailing delimiter
 * (so `mapfile` without `-t` retains the newline). A trailing empty record after
 * a final delimiter is dropped (bash does not store it).
 */
function splitKeepingDelimiter(data: string, delim: string): string[] {
  if (data === '') return [];
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const idx = data.indexOf(delim, start);
    if (idx < 0) { out.push(data.slice(start)); break; }
    out.push(data.slice(start, idx + delim.length));
    start = idx + delim.length;
    if (start >= data.length) break; // final delimiter ⇒ no trailing empty record
  }
  return out;
}

/** Unary string-test operators the pure `test`/`[` supports (no VFS file tests). */
const TEST_UNARY = new Set(['-z', '-n']);

function unaryTest(op: string, s: string): boolean {
  switch (op) {
    case '-z': return s === '';
    case '-n': return s !== '';
    default: return s !== ''; // an unsupported unary treated as a 1-arg string test
  }
}

/**
 * Parse a `test`/`[ ]` numeric operand as a 64-bit integer. POSIX `test` operands
 * are DECIMAL (bash `[ 010 -eq 10 ]` is true — `010` is decimal ten, not octal;
 * `[ 0x10 ... ]` errors). 64-bit BigInt keeps precision beyond 2^53 (a JS `Number`
 * would not). A non-numeric operand → 0 (the mock surface returns false, not error).
 */
function testInt(s: string): bigint {
  const t = s.trim();
  const m = /^([+-]?)0*([0-9]+)$/.exec(t); // decimal, leading zeros stripped
  if (m === null) return 0n;
  try { return BigInt(m[1] + (m[2] || '0')); } catch { return 0n; }
}

/** The 64-bit integer comparison operators for `test`/`[` (DECIMAL operands). */
export function testNumericCompare(a: string, op: string, b: string): boolean | undefined {
  const x = testInt(a), y = testInt(b);
  switch (op) {
    case '-eq': return x === y;
    case '-ne': return x !== y;
    case '-lt': return x < y;
    case '-le': return x <= y;
    case '-gt': return x > y;
    case '-ge': return x >= y;
    default: return undefined;
  }
}

function binaryTest(a: string, op: string, b: string): boolean {
  switch (op) {
    case '=':
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;   // lexical (byte) ordering, as in bash test/[
    case '>': return a > b;
    default: return testNumericCompare(a, op, b) ?? false;
  }
}

/**
 * POSIX `test`/`[` evaluation. Handles the 0/1/2/3-arg special forms exactly as
 * POSIX specifies, then a general recursive grammar for 4+ args with `!`
 * negation, `-a` (AND, binds tighter) / `-o` (OR), and `( )` grouping.
 */
function evalTest(args: string[]): boolean {
  // POSIX-defined short forms (evaluated positionally, not by the grammar).
  switch (args.length) {
    case 0: return false;
    case 1: return args[0] !== '';
    case 2:
      if (args[0] === '!') return !(args[1] !== '');
      if (TEST_UNARY.has(args[0])) return unaryTest(args[0], args[1]);
      return args[1] !== ''; // unknown unary → treat operand as a string test
    case 3: {
      // POSIX: when args[1] is a known binary operator, this is `a OP b` —
      // regardless of what args[0] looks like (`[ "!" = "!" ]` is equality, not
      // negation). Otherwise `! expr2` or `( expr1 )`.
      const BINARY_OPS = ['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'];
      if (BINARY_OPS.includes(args[1])) return binaryTest(args[0], args[1], args[2]);
      if (args[0] === '!') return !evalTest(args.slice(1));
      if (args[0] === '(' && args[2] === ')') return evalTest([args[1]]);
      return binaryTest(args[0], args[1], args[2]);
    }
    case 4:
      if (args[0] === '!') return !evalTest(args.slice(1));
      break;
  }
  return new TestParser(args).parseExpr();
}

/** Recursive-descent evaluator for 4+-token test expressions (-a/-o/!/( )). */
class TestParser {
  private pos = 0;
  private readonly toks: string[];
  constructor(toks: string[]) { this.toks = toks; }
  private peek(): string | undefined { return this.toks[this.pos]; }

  parseExpr(): boolean { return this.parseOr(); }

  private parseOr(): boolean {
    let v = this.parseAnd();
    while (this.peek() === '-o') { this.pos++; const r = this.parseAnd(); v = v || r; }
    return v;
  }
  private parseAnd(): boolean {
    let v = this.parseUnary();
    while (this.peek() === '-a') { this.pos++; const r = this.parseUnary(); v = v && r; }
    return v;
  }
  private parseUnary(): boolean {
    if (this.peek() === '!') { this.pos++; return !this.parseUnary(); }
    return this.parsePrimary();
  }
  private parsePrimary(): boolean {
    if (this.peek() === '(') {
      this.pos++;
      const v = this.parseOr();
      if (this.peek() === ')') this.pos++;
      return v;
    }
    // A binary primary `a OP b` when the next-next token is a known binary op;
    // otherwise a single-token string test.
    const a = this.toks[this.pos];
    const op = this.toks[this.pos + 1];
    const isBinaryOp = op !== undefined && ['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op);
    if (isBinaryOp) { this.pos += 3; return binaryTest(a, op, this.toks[this.pos - 1]); }
    if (a !== undefined && TEST_UNARY.has(a) && this.toks[this.pos + 1] !== undefined) {
      this.pos += 2; return unaryTest(a, this.toks[this.pos - 1]);
    }
    this.pos++;
    return a !== undefined && a !== '';
  }
}

/**
 * GNU/bash-compatible printf. Supports:
 *   - conversions: %s %b %c %d %i %u %o %x %X %f %e %E %g %G %q %%
 *   - flags `-` (left), `+` (sign), space, `0` (zero-pad), `#` (alt)
 *   - width and precision, including `*` taking them from args
 *   - format-string recycling: extra args reapply the format
 *   - escapes in the format: \n \t \r \\ \a \b \f \v \" \xNN \0nnn \nnn
 *   - %b interprets escapes in the ARGUMENT
 *   - integer args: leading-`'`/`"` char code, 0x hex, 0 octal, or decimal
 */
/** Result of a `printf` run: the produced output + any number/format errors (exit 1). */
interface PrintfResult { out: string; errors: string[] }

function formatPrintf(format: string, args: string[]): PrintfResult {
  const fmt = interpretEscapes(format, /*octalBackslashZero*/ true);
  let out = '';
  let argi = 0;
  const errors: string[] = [];
  let stop = false;                          // `%b`'s `\c` truncates ALL output
  // Track whether the arg just consumed was actually PRESENT: a MISSING numeric
  // arg is 0 with no diagnostic (bash), but a present-but-invalid one errors.
  let lastPresent = true;
  const nextArg = (): string => { lastPresent = argi < args.length; return args[argi++] ?? ''; };
  // A single pass over the format; repeat while args remain and the format
  // consumed at least one conversion (recycling). `consumedConversion` guards
  // against infinite loops on formats with no conversions.
  do {
    const startArgi = argi;
    let consumedConversion = false;
    let i = 0;
    while (i < fmt.length && !stop) {
      const c = fmt[i];
      if (c !== '%') { out += c; i++; continue; }
      if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
      // Parse a conversion spec: %[flags][width][.precision]conv
      const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sbcdiuoxXeEfgGq])/.exec(fmt.slice(i));
      if (!m) { out += c; i++; continue; } // lone % with no valid conversion
      consumedConversion = true;
      let flags = m[1];
      let width = m[2] === '*' ? parseInt(nextArg(), 10) || 0 : (m[2] ? parseInt(m[2], 10) : undefined);
      // A negative dynamic width (`%*d -5 …`) means left-justify with abs width.
      if (width !== undefined && width < 0) { flags += '-'; width = -width; }
      let prec: number | undefined;
      if (m[3] === '*') {
        // A negative dynamic precision (`%.*f -1 …`) means "unset" in bash.
        const dyn = parseInt(nextArg(), 10) || 0;
        prec = dyn < 0 ? undefined : dyn;
      } else if (m[3] !== undefined) prec = parseInt(m[3], 10);
      const conv = m[4];
      const argVal = nextArg();
      const argPresent = lastPresent;
      const r = formatOne(conv, flags, width, prec, argVal);
      out += r.text;
      // A missing numeric arg is 0 with no diagnostic; only a PRESENT invalid /
      // out-of-range arg errors (exit 1, but the value is still printed).
      if (argPresent && r.error !== undefined) errors.push(r.error);
      if (r.stop) stop = true;
      i += m[0].length;
    }
    if (stop) break;
    if (!consumedConversion) break;           // no conversions ⇒ print once
    if (argi === startArgi) break;            // conversions but consumed no args ⇒ stop
  } while (argi < args.length);
  return { out, errors };
}

/** One conversion's output plus an optional `error` (exit 1) and a `\c` `stop` flag. */
interface OneResult { text: string; error?: string; stop?: boolean }

/** Format a single conversion. `arg` is the raw string argument. */
function formatOne(conv: string, flags: string, width: number | undefined, prec: number | undefined, arg: string): OneResult {
  const left = flags.includes('-');
  const zero = flags.includes('0') && !left;
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');

  let body: string;
  let signPrefix = '';

  switch (conv) {
    case 's': {
      body = arg;
      if (prec !== undefined) body = body.slice(0, prec);
      return { text: pad(body, width, left, false) };
    }
    case 'b': {
      // `%b` interprets escapes in the ARGUMENT; a `\c` stops ALL further output.
      const { text, stop } = interpretBEscapes(arg);
      body = text;
      if (prec !== undefined) body = body.slice(0, prec);
      return { text: pad(body, width, left, false), stop };
    }
    case 'c': {
      // `%c` prints the FIRST character of the argument; an EMPTY argument yields a
      // single NUL byte (bash: `printf '[%c]' ''` → `[` NUL `]`).
      body = arg === '' ? '\0' : arg.slice(0, 1);
      return { text: pad(body, width, left, false) };
    }
    case 'q':
      // Shell-quote for safe re-input, bash `printf %q` backslash style; honors
      // width/left-justify like the other string conversions.
      return { text: pad(shellQuoteBackslash(arg), width, left, false) };
    case 'd': case 'i': case 'u': {
      // 64-bit intmax_t/uintmax_t via BigInt. Signed convs saturate out-of-range
      // (with a warning, exit 0); %u reinterprets the value mod 2^64.
      const parsed = parseIntArg(arg, /*unsigned*/ conv === 'u');
      let digits: string;
      if (conv === 'u') {
        const uv = ((parsed.value % TWO_POW_64) + TWO_POW_64) % TWO_POW_64;
        digits = uv.toString(10);
      } else {
        const neg = parsed.value < 0n;
        digits = (neg ? -parsed.value : parsed.value).toString(10);
        signPrefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      }
      if (prec !== undefined) { digits = digits.padStart(prec, '0'); if (prec === 0 && parsed.value === 0n) digits = ''; }
      body = digits;
      return { text: padNum(signPrefix, body, width, left, zero && prec === undefined), error: parsed.error };
    }
    case 'o': case 'x': case 'X': {
      // Unsigned base conversions mask to 64 bits (two's-complement for negatives),
      // matching bash's uintmax_t (`printf %x -1` → ffffffffffffffff).
      const parsed = parseIntArg(arg, /*unsigned*/ true);
      const uv = ((parsed.value % TWO_POW_64) + TWO_POW_64) % TWO_POW_64;
      let digits = uv.toString(conv === 'o' ? 8 : 16);
      if (conv === 'X') digits = digits.toUpperCase();
      if (prec !== undefined) { digits = digits.padStart(prec, '0'); if (prec === 0 && uv === 0n) digits = ''; }
      let altPrefix = '';
      if (alt && uv !== 0n) altPrefix = conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X';
      body = digits;
      return { text: padNum(altPrefix, body, width, left, zero && prec === undefined), error: parsed.error };
    }
    case 'f': case 'e': case 'E': case 'g': case 'G': {
      const parsed = parseFloatArg(arg);
      const num = parsed.value;
      if (prec !== undefined && prec < 0) prec = undefined; // defensive: negative → unset
      const p = prec ?? 6;
      let s: string;
      if (conv === 'f') s = Math.abs(num).toFixed(p);
      else if (conv === 'e' || conv === 'E') s = formatExp(Math.abs(num), p, conv === 'E');
      else s = formatG(Math.abs(num), prec === undefined ? 6 : (prec === 0 ? 1 : prec), conv === 'G', alt);
      const neg = num < 0 || Object.is(num, -0);
      signPrefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      body = s;
      return { text: padNum(signPrefix, body, width, left, zero), error: parsed.error };
    }
    default:
      return { text: '' };
  }
}

/**
 * Interpret `%b`-argument escapes. Like {@link interpretEscapes} but a `\c`
 * truncates output immediately (return `stop`), matching bash/GNU `printf %b`.
 */
function interpretBEscapes(s: string): { text: string; stop: boolean } {
  // Find a GENUINE `\c` escape — one whose backslash is not itself escaped. Walk
  // the string so `\\c` (escaped backslash + literal `c`) does NOT trigger the stop.
  let ci = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') continue;
    if (s[i + 1] === 'c') { ci = i; break; }
    i++; // skip the escaped char (incl. `\\`) so its second `\` isn't rescanned
  }
  if (ci < 0) return { text: interpretEscapes(s, /*octalBackslashZero*/ false), stop: false };
  return { text: interpretEscapes(s.slice(0, ci), /*octalBackslashZero*/ false), stop: true };
}

/** Left/right pad a plain string to `width`. */
function pad(s: string, width: number | undefined, left: boolean, _zero: boolean): string {
  if (width === undefined || s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return left ? s + fill : fill + s;
}

/** Pad a numeric body that has a sign/prefix, honoring zero-fill between them. */
function padNum(prefix: string, body: string, width: number | undefined, left: boolean, zero: boolean): string {
  const total = prefix.length + body.length;
  if (width === undefined || total >= width) return prefix + body;
  const fillLen = width - total;
  if (left) return prefix + body + ' '.repeat(fillLen);
  if (zero) return prefix + '0'.repeat(fillLen) + body;
  return ' '.repeat(fillLen) + prefix + body;
}

/** `%e` formatting: mantissa + e±NN (≥2 exponent digits). */
function formatExp(n: number, prec: number, upper: boolean): string {
  let s = n.toExponential(prec); // e.g. "1.234500e+4"
  s = s.replace(/e([+-])(\d)$/, 'e$10$2'); // pad exponent to 2 digits
  return upper ? s.toUpperCase() : s;
}

/** `%g` formatting: shortest of %e/%f, trailing zeros trimmed unless `#`. */
function formatG(n: number, sig: number, upper: boolean, alt: boolean): string {
  if (n === 0) return alt ? '0.' + '0'.repeat(Math.max(0, sig - 1)) : '0';
  const exp = Math.floor(Math.log10(n));
  let s: string;
  if (exp < -4 || exp >= sig) {
    s = formatExp(n, sig - 1, upper);
    if (!alt) s = s.replace(/\.?0+e/, 'e');
  } else {
    s = n.toFixed(Math.max(0, sig - 1 - exp));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

/** A parsed printf FLOAT argument + an optional "invalid number" diagnostic. */
interface NumArg { value: number; error?: string }

/**
 * A parsed printf INTEGER argument (64-bit `intmax_t`/`uintmax_t` via BigInt) plus
 * an optional `error`. Every diagnostic (invalid/partial number, invalid octal/hex,
 * out-of-range "Result too large") is a hard ERROR: bash exits 1 but STILL prints
 * the parsed/saturated value. There is no exit-0 warning path.
 */
interface IntArg { value: bigint; error?: string }

const TWO_POW_64 = 1n << 64n;
const INTMAX_MAX = (1n << 63n) - 1n;      // 9223372036854775807
const INTMAX_MIN = -(1n << 63n);          // -9223372036854775808
const UINTMAX_MAX = TWO_POW_64 - 1n;      // 18446744073709551615
const UINTMAX_MIN = -(TWO_POW_64 - 1n);   // -(2^64-1): bash's low bound for %u/%x/%o

/** Parse a magnitude string of the given base into a BigInt (avoids Number). */
function digitsToBig(digits: string, base: bigint): bigint {
  let v = 0n;
  for (const d of digits) v = v * base + BigInt(parseInt(d, Number(base)));
  return v;
}

/**
 * Parse a printf integer argument as a 64-bit value: `'c` char code, ±0x hex,
 * ±0 octal, ±decimal (leading whitespace allowed). bash diagnostics (all exit 1,
 * value still printed):
 *   - non-numeric token → `invalid number` (value 0)
 *   - partial token (`12abc`) → `invalid number`, keeps leading digits of its base
 *     (`0x1g` keeps hex `1`; `12abc` keeps `12`)
 *   - `08`/`09`/`0778` → `invalid octal number`, keeps the leading valid octal run
 *   - `0xg`/`0x` → `invalid hex number` (value 0)
 *   - out-of-range → `Result too large`, saturates. Signed convs clamp to
 *     [INTMAX_MIN, INTMAX_MAX]; unsigned (`%u`/`%x`/`%o`) allow [-(2^64-1), 2^64-1].
 */
function parseIntArg(arg: string, unsigned: boolean): IntArg {
  // Only LEADING whitespace is skipped (bash strtoimax); TRAILING content makes it a
  // partial/invalid number (`'42 '` → invalid), unlike the whole-string trim before.
  const s = arg.replace(/^\s+/, '');
  // A leading quote yields the next char's code point (unclamped, always in range).
  if (s[0] === '\'' || s[0] === '"') return { value: BigInt(s.codePointAt(1) ?? 0) };
  const signed = s[0] === '+' || s[0] === '-';
  const sign = s[0] === '-' ? -1n : 1n;
  const body = signed ? s.slice(1) : s;
  // A SIGNED token (leading +/-) that fails to parse cleanly reports the GENERIC
  // "invalid number" (bash), not "invalid hex/octal number".
  const badWord = signed ? 'invalid number' : undefined;
  // Hex: `0x…`. A trailing non-hex char is a partial-parse error keeping the run.
  if (/^0[xX]/.test(body)) {
    const hex = body.slice(2).match(/^[0-9a-fA-F]+/);
    if (hex === null) return { value: 0n, error: `${arg}: ${badWord ?? 'invalid hex number'}` };
    const val = clampInt(digitsToBig(hex[0], 16n) * sign, unsigned, arg);
    if (hex[0].length !== body.length - 2) return { value: val.value, error: `${arg}: ${badWord ?? 'invalid hex number'}` };
    return val;
  }
  // Octal: a leading `0` followed by digits. `08`/`09`/`0778` are invalid octal but
  // keep the leading valid-octal run (bash: `0778` → 63 = 0o77).
  if (/^0[0-9]+$/.test(body)) {
    const oct = body.slice(1).match(/^[0-7]+/);
    const octRun = oct ? oct[0] : '';
    const val = clampInt(digitsToBig(octRun, 8n) * sign, unsigned, arg);
    if (octRun.length !== body.length - 1) return { value: val.value, error: `${arg}: ${badWord ?? 'invalid octal number'}` };
    return val;
  }
  // Decimal (incl. a bare `0`).
  if (/^\d+$/.test(body)) return clampInt(digitsToBig(body, 10n) * sign, unsigned, arg);
  // Not a clean integer: keep any leading decimal digits (bash prints those).
  const lead = body.match(/^\d+/);
  if (lead === null) return { value: 0n, error: `${arg}: invalid number` };
  return { value: clampInt(digitsToBig(lead[0], 10n) * sign, unsigned, arg).value, error: `${arg}: invalid number` };
}

/**
 * Clamp a BigInt to the printf target range. Out-of-range saturates and is an ERROR
 * (bash exits 1 but prints the saturated value). Signed convs clamp to [INTMAX_MIN,
 * INTMAX_MAX]. Unsigned (`%u`/`%x`/`%o`) allow [-(2^64-1), 2^64-1]: a value ABOVE
 * the range OR BELOW -(2^64-1) both saturate to UINTMAX_MAX (bash). The message
 * quotes the ORIGINAL argument token (`ARG: Result too large`).
 */
function clampInt(v: bigint, unsigned: boolean, arg: string): IntArg {
  if (unsigned) {
    if (v > UINTMAX_MAX || v < UINTMAX_MIN) return { value: UINTMAX_MAX, error: `${arg.trim()}: Result too large` };
    return { value: v };
  }
  if (v > INTMAX_MAX) return { value: INTMAX_MAX, error: `${arg.trim()}: Result too large` };
  if (v < INTMAX_MIN) return { value: INTMAX_MIN, error: `${arg.trim()}: Result too large` };
  return { value: v };
}

function parseFloatArg(arg: string): NumArg {
  const s = arg.trim();
  if (s[0] === '\'' || s[0] === '"') return { value: s.codePointAt(1) ?? 0 };
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || /^[+-]?0[xX][0-9a-fA-F.pP+-]+$/.test(s)) {
    const v = parseFloat(s);
    return { value: Number.isNaN(v) ? 0 : v };
  }
  const v = parseFloat(s);
  if (Number.isNaN(v)) return { value: 0, error: `${arg}: invalid number` };
  return { value: v, error: `${arg}: value not completely converted` };
}

