/**
 * Shell builtins — commands that run in-process (no spawn), mutating shell
 * state (cwd, env, functions, jobs) and/or writing to the current stdout/stderr.
 */

import { shellQuoteBackslash } from './quote.ts';
import { interpretEscapes } from './escape.ts';

/** Richer shell state surface a few builtins need (functions, jobs, positionals). */
export interface ShellState {
  functions: Map<string, { name: string; body: unknown }>;
  jobs: Array<{ id: number; pids: number[]; command: string; state: string; exitCode?: number }>;
  positional: string[];
  setPositional(p: string[]): void;
  shiftPositional(n: number): void;
  /** Mark a name as local to the current function scope. */
  declareLocal(name: string): void;
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
  /** Record a `declare -n ref=target` nameref (single-level). */
  setNameref?(ref: string, target: string): void;
  /** Resolve a nameref to its target (single-level), or undefined if not a nameref. */
  resolveNameref?(name: string): string | undefined;
  /**
   * The directory stack BELOW the current directory (`pushd`/`popd`/`dirs`),
   * most-recent-first. The live array — `dirs`/`pushd`/`popd` mutate it in place.
   * The current directory (`ctx.cwd`) is the conceptual top and is NOT stored here.
   */
  dirStack?(): string[];
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
   * A3 Tier 2: read one line of PLAIN stdin (no `-u`). When `stringStdin` is set
   * (a here-doc / `pipeStdin` / `<` redirect), serve from it; otherwise from the
   * shell's LIVE stdin stream, racing `timeoutSec` (for `read -t`). `timedOut`
   * true ⇒ the timer won (the var is left empty and `read` returns >128).
   */
  readStdinLine?(stringStdin: string | undefined, timeoutSec?: number): Promise<{ line: string | undefined; timedOut: boolean }>;
  lastStatus?: number;
  stdin?: string;
  /** Loop/function control — implemented by the executor as thrown unwinds. */
  doBreak?(n: number): never;
  doContinue?(n: number): never;
  doReturn?(n: number): never;
  /**
   * Evaluate a single arithmetic expression over the live shell env (assignments
   * mutate the env), returning its integer value — backs the `let` builtin.
   * Implemented by the executor over the same env proxy `(( ))` uses.
   */
  evalArith?(expr: string): number;
  /** Richer state for local/declare/shift/getopts/jobs/wait. */
  state?: ShellState;
}

export const BUILTINS = [
  'cd', 'pwd', 'export', 'unset', 'echo', 'printf',
  'test', '[', 'true', 'false', 'exit', 'eval', 'set', 'cat', ':',
  'local', 'declare', 'readonly', 'let', 'shift', 'return', 'getopts', 'read',
  'mapfile', 'readarray',
  'jobs', 'fg', 'bg', 'wait', 'kill', 'break', 'continue', 'source', '.', 'type',
  'shopt', 'trap', 'disown', 'history', 'fc', 'exec', 'coproc',
  'dirs', 'pushd', 'popd',
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

    case 'printf':
      ctx.write(formatPrintf(args[0] ?? '', args.slice(1)));
      return 0;

    case 'export': {
      let status = 0;
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
      for (const arg of args) {
        // A readonly variable cannot be unset (bash: `unset: <name>: cannot unset:
        // readonly variable`, status 1). Functions are unaffected by readonly.
        if (ctx.state?.isReadonly?.(arg)) {
          errOut(ctx, `shell: unset: ${arg}: cannot unset: readonly variable\n`);
          status = 1;
          continue;
        }
        delete ctx.env[arg];
        ctx.state?.functions.delete(arg);
      }
      return status;
    }

    case 'local':
    case 'declare':
    case 'readonly': {
      // Assign NAME=value into the (function-local for `local`) env.
      const isLocal = name === 'local';
      const isReadonly = name === 'readonly';
      const isAssoc = name === 'declare' && args.includes('-A');
      // `declare -n ref=target` declares a nameref (single-level): reads of `ref`
      // and writes to `ref` are redirected to `target` (the latter in the
      // executor's applyAssignment). Recorded instead of storing a literal value.
      const isNameref = name === 'declare' && args.includes('-n');
      if (isAssoc && (ctx.state?.getOption('posix') ?? false)) {
        errOut(ctx, 'shell: declare: -A: not supported in POSIX mode\n');
        return 2;
      }
      for (const arg of args) {
        if (arg.startsWith('-')) continue; // ignore option flags (-i, -a, etc.)
        const eq = arg.indexOf('=');
        const n = eq > 0 ? arg.slice(0, eq) : arg;
        if (isNameref) {
          // `declare -n ref=target`: record the mapping (no literal value stored).
          if (eq > 0) ctx.state?.setNameref?.(n, arg.slice(eq + 1));
          continue;
        }
        // `declare -A name` registers an associative array (G6).
        if (isAssoc) ctx.state?.declareAssoc?.(n);
        if (eq > 0) {
          // Reassigning an already-readonly var via declare/local fails (bash). The
          // `readonly NAME=val` form is exempt — it sets THEN marks below, so a
          // first `readonly RO=1` succeeds; only a later write to RO is rejected.
          if (!isReadonly && ctx.state?.isReadonly?.(n)) {
            errOut(ctx, `shell: ${name}: ${n}: readonly variable\n`);
            return 1;
          }
          if (isLocal) ctx.state?.declareLocal(n);
          if (!isAssoc) ctx.env[n] = arg.slice(eq + 1);
        } else if (isLocal) {
          ctx.state?.declareLocal(arg);
          if (!(arg in ctx.env)) ctx.env[arg] = '';
        }
        // `readonly NAME[=val]` marks the name AFTER its value is set, so the
        // builtin's own assignment succeeds; later reassignments are rejected by
        // the executor's applyAssignment (POSIX-fatal in posix mode).
        if (isReadonly) ctx.state?.markReadonly?.(n);
      }
      return 0;
    }

    case 'let': {
      // Evaluate each arithmetic expression over the live env (assignments take).
      // Exit status mirrors bash: 1 when the LAST expression evaluates to 0, else
      // 0. No expressions → status 1. A malformed expression / division by zero is
      // a per-command error (status 2 + diagnostic), NOT a script abort.
      if (args.length === 0) return 1;
      let last = 0;
      try {
        for (const expr of args) last = ctx.evalArith?.(expr) ?? 0;
      } catch (e) {
        errOut(ctx, `shell: let: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
      return last === 0 ? 1 : 0;
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

    case 'cat':
      ctx.write(ctx.stdin ?? '');
      return 0;

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
      let status = 0;
      for (const a of args) {
        if (ctx.state?.functions.has(a)) ctx.write(`${a} is a function\n`);
        else if (isBuiltin(a)) ctx.write(`${a} is a shell builtin\n`);
        else { errOut(ctx, `type: ${a}: not found\n`); status = 1; }
      }
      return status;
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
  // Unknown letters (`-s`/`-p`) are no-ops. Non-`-` args are variable names.
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
      j++; // unknown short flag (e.g. -s/-p): no-op
    }
  }
  if (timeoutSec !== undefined && Number.isNaN(timeoutSec)) timeoutSec = undefined;
  if (maxChars !== undefined && Number.isNaN(maxChars)) maxChars = undefined;

  const finish = (line: string): number => {
    const cooked = raw ? line : unescapeReadLine(line);
    if (arrayName !== undefined) {
      const fields = cooked.split(/\s+/).filter((f) => f !== '');
      ctx.state?.setArray?.(arrayName, fields);
      return 0;
    }
    const fields = cooked.split(/\s+/).filter((f) => f !== '');
    assignReadVars(names, fields, cooked, ctx);
    return 0;
  };

  // `-d`/`-n` operate on the raw stdin STRING directly (the live-stream line
  // reader is newline-/line-oriented and does not model these). The harness
  // feeds `read` via a materialized `ctx.stdin`, which covers these cases.
  if ((delim !== undefined || maxChars !== undefined) && fdArg === undefined) {
    const stdin = ctx.stdin ?? '';
    if (stdin === '') return 1; // EOF
    let end: number;
    if (ignoreDelim) {
      // `-N N`: read exactly N chars (or to EOF), ignoring any delimiter.
      end = maxChars !== undefined && maxChars >= 0 ? Math.min(maxChars, stdin.length) : stdin.length;
    } else {
      const term = delim === undefined ? '\n' : (delim === '' ? '\0' : delim[0]);
      end = stdin.indexOf(term);
      if (end < 0) end = stdin.length; // no terminator ⇒ read to EOF (success in bash if non-empty)
      if (maxChars !== undefined && maxChars >= 0 && maxChars < end) end = maxChars; // `-n N`: stop at delim OR N
    }
    return finish(stdin.slice(0, end));
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
      else assignReadVars(names, [], '', ctx);
      return READ_TIMEOUT_STATUS;
    }
    ctx.consumeFdLine?.(fdArg); // we used this line; the next read fetches a fresh one
    if (line === undefined) return 1; // EOF or fd not open
    return finish(line);
  }

  // A3 Tier 2: plain `read` — prefer the live-stdin line reader (supports `-t`
  // and sequential reads over a stream); fall back to the legacy first-line-of-
  // `ctx.stdin` string behavior when the executor provides no `readStdinLine`.
  if (ctx.readStdinLine) {
    const { line, timedOut } = await ctx.readStdinLine(ctx.stdin, timeoutSec);
    if (timedOut) {
      if (arrayName !== undefined) ctx.state?.setArray?.(arrayName, []);
      else assignReadVars(names, [], '', ctx);
      return READ_TIMEOUT_STATUS;
    }
    if (line === undefined) return 1; // EOF
    return finish(line);
  }

  const stdin = ctx.stdin ?? '';
  const nl = stdin.indexOf('\n');
  const line = nl >= 0 ? stdin.slice(0, nl) : stdin;
  if (stdin === '') return 1; // EOF
  return finish(line);
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

/** Assign a read line's fields to NAMEs (last name absorbs the rest); no names → $REPLY. */
function assignReadVars(names: string[], fields: string[], line: string, ctx: BuiltinContext): void {
  if (names.length === 0) { ctx.env.REPLY = line; return; }
  for (let i = 0; i < names.length; i++) {
    if (i === names.length - 1) ctx.env[names[i]] = fields.slice(i).join(' ');
    else ctx.env[names[i]] = fields[i] ?? '';
  }
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
  // plain stdin, the materialized `ctx.stdin` string holds the whole input.
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
    data = ctx.stdin ?? '';
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

function evalTest(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== '';
  if (args.length === 2) {
    const [op, s] = args;
    switch (op) {
      case '-z': return s === '';
      case '-n': return s !== '';
      case '!': return !evalTest([s]);
      default: return true;
    }
  }
  if (args.length === 3) {
    const [a, op, b] = args;
    switch (op) {
      case '=':
      case '==': return a === b;
      case '!=': return a !== b;
      case '-eq': return Number(a) === Number(b);
      case '-ne': return Number(a) !== Number(b);
      case '-lt': return Number(a) < Number(b);
      case '-le': return Number(a) <= Number(b);
      case '-gt': return Number(a) > Number(b);
      case '-ge': return Number(a) >= Number(b);
      default: return false;
    }
  }
  if (args[0] === '!') return !evalTest(args.slice(1));
  return false;
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
function formatPrintf(format: string, args: string[]): string {
  const fmt = interpretEscapes(format, /*octalBackslashZero*/ true);
  let out = '';
  let argi = 0;
  const nextArg = (): string => args[argi++] ?? '';
  // A single pass over the format; repeat while args remain and the format
  // consumed at least one conversion (recycling). `consumedConversion` guards
  // against infinite loops on formats with no conversions.
  do {
    const startArgi = argi;
    let consumedConversion = false;
    let i = 0;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c !== '%') { out += c; i++; continue; }
      if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
      // Parse a conversion spec: %[flags][width][.precision]conv
      const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sbcdiuoxXeEfgGq])/.exec(fmt.slice(i));
      if (!m) { out += c; i++; continue; } // lone % with no valid conversion
      consumedConversion = true;
      const [whole, flags] = m;
      let width = m[2];
      let prec = m[3];
      if (width === '*') width = String(parseInt(nextArg(), 10) || 0);
      if (prec === '*') prec = String(parseInt(nextArg(), 10) || 0);
      const conv = m[4];
      out += formatOne(conv, flags, width ? parseInt(width, 10) : undefined,
        prec !== undefined ? parseInt(prec, 10) : undefined, nextArg());
      i += whole.length;
    }
    if (!consumedConversion) break;           // no conversions ⇒ print once
    if (argi === startArgi) break;            // conversions but consumed no args ⇒ stop
  } while (argi < args.length);
  return out;
}

/** Format a single conversion. `arg` is the raw string argument. */
function formatOne(conv: string, flags: string, width: number | undefined, prec: number | undefined, arg: string): string {
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
      return pad(body, width, left, false);
    }
    case 'b': {
      body = interpretEscapes(arg, /*octalBackslashZero*/ false);
      if (prec !== undefined) body = body.slice(0, prec);
      return pad(body, width, left, false);
    }
    case 'c': {
      body = arg.slice(0, 1);
      return pad(body, width, left, false);
    }
    case 'q':
      // Shell-quote for safe re-input, bash `printf %q` backslash style; honors
      // width/left-justify like the other string conversions.
      return pad(shellQuoteBackslash(arg), width, left, false);
    case 'd': case 'i': case 'u': {
      let v = parseIntArg(arg);
      if (conv === 'u' && v < 0) v = v >>> 0;
      const neg = v < 0;
      let digits = Math.abs(v).toString(10);
      if (prec !== undefined) { digits = digits.padStart(prec, '0'); if (prec === 0 && v === 0) digits = ''; }
      signPrefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      body = digits;
      return padNum(signPrefix, body, width, left, zero && prec === undefined);
    }
    case 'o': case 'x': case 'X': {
      let v = parseIntArg(arg);
      if (v < 0) v = v >>> 0;
      let digits = v.toString(conv === 'o' ? 8 : 16);
      if (conv === 'X') digits = digits.toUpperCase();
      if (prec !== undefined) { digits = digits.padStart(prec, '0'); if (prec === 0 && v === 0) digits = ''; }
      let altPrefix = '';
      if (alt && v !== 0) altPrefix = conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X';
      body = digits;
      return padNum(altPrefix, body, width, left, zero && prec === undefined);
    }
    case 'f': case 'e': case 'E': case 'g': case 'G': {
      const num = parseFloatArg(arg);
      const p = prec ?? 6;
      let s: string;
      if (conv === 'f') s = Math.abs(num).toFixed(p);
      else if (conv === 'e' || conv === 'E') s = formatExp(Math.abs(num), p, conv === 'E');
      else s = formatG(Math.abs(num), prec === undefined ? 6 : (prec === 0 ? 1 : prec), conv === 'G', alt);
      const neg = num < 0 || Object.is(num, -0);
      signPrefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      body = s;
      return padNum(signPrefix, body, width, left, zero);
    }
    default:
      return '';
  }
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

/** Parse a printf integer argument: `'c` char code, 0x hex, 0 octal, decimal. */
function parseIntArg(arg: string): number {
  const s = arg.trim();
  if (s[0] === '\'' || s[0] === '"') return s.codePointAt(1) ?? 0;
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^[+-]?0[0-7]+$/.test(s)) return parseInt(s, 8);
  const v = parseInt(s, 10);
  return Number.isNaN(v) ? 0 : v;
}

function parseFloatArg(arg: string): number {
  const s = arg.trim();
  if (s[0] === '\'' || s[0] === '"') return s.codePointAt(1) ?? 0;
  const v = parseFloat(s);
  return Number.isNaN(v) ? 0 : v;
}

