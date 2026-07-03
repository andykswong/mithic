/**
 * Shell executor.
 *
 * Builtin-first dispatch: builtins run in-process (mutating shell state);
 * non-builtins fork CHILD processes via the kernel `process/spawn` /
 * `process/pipeline` syscalls. The executor implements the {@link ShellEnv}
 * surface the {@link Expander} needs (variable lookup, special/positional
 * params, command substitution, and VFS access for glob).
 *
 * Implemented control flow: pipelines (with `!` negation), `&&`/`||`, `if`,
 * `while`/`until`, `for`, `case`, function definitions+calls, subshells/groups,
 * `(( ))` arithmetic commands, `[[ ]]` conditionals. Loop control via
 * break/continue, function return, and `exit` use exceptions to unwind.
 *
 * Redirects: `>` `>>` `<` `<<` (here-doc) `<<<` (here-string) `2>` `&>` `2>&1`
 * `/dev/null`. Job control: `&` backgrounding, a job table, and
 * `jobs`/`fg`/`bg`/`wait`. Signal-based suspension (SIGSTOP/SIGCONT) is not
 * available in this runtime — see notes in the job builtins.
 */

import type { Assignment, Program, Redirect, SimpleCommand, Statement } from './ast.ts';
import { parse } from './parser.ts';
import { StdinReader } from './stdin-reader.ts';
import { toSink, sinkToStream, BrokenPipeError, type OutputSink } from './output-sink.ts';
import { evalArith } from './arith.ts';
import type { ArithArrayAccess } from './arith.ts';
import { globMatch } from './glob.ts';
import type { GlobOptions } from './glob.ts';
import { Expander, ExpansionError } from './expander.ts';
import { shellQuoteQ } from './quote.ts';
import { expandHistory, HistoryEventNotFound } from './history-expand.ts';
import { isBuiltin, isShellKeyword, runBuiltin, OPTION_FLAGS, SET_O_OPTIONS, SHOPT_NAMES, PosixSpecialBuiltinError, POSIX_SPECIAL_BUILTINS, testNumericCompare } from './builtins.ts';
import type { BuiltinContext, ShellState, ShellOptionName } from './builtins.ts';
import { Environment, computeShlvl } from './environment.ts';
import type { EnvHost } from './environment.ts';
import { JobController } from './job-controller.ts';
import type {
  DuplexFd,
  FsClient,
  KernelClient,
  PipelineStageParams,
  SpawnParams,
  StdinFdSpec,
} from './kernel-client.ts';

export interface ShellFunction {
  name: string;
  body: Statement[];
}

/**
 * A persistent numbered file descriptor opened by `exec N>file` / `exec N<file`
 * / `exec N<>file`. Output fds carry a write sink + closer; input fds carry the
 * buffered file contents and a read cursor (for `read -u N`).
 */
interface FdEntry {
  mode: 'read' | 'write' | 'rw';
  /** Write sink for output fds. */
  sink?: OutputSink;
  /** Close the underlying file (flush). */
  close?: () => void;
  /** Buffered input contents (read fds). */
  input?: string;
  /** Read cursor into `input`. */
  pos?: number;
  /**
   * A LIVE bidirectional descriptor for a STREAMING `exec N<>path` (e.g.
   * `/dev/tcp/host/port`). When present, `read -u N` reads from it on demand and
   * the fd's write sink targets it — instead of the buffered `input`/`sink` path
   * (which deadlocks on a socket: see {@link DuplexFd}).
   */
  duplex?: DuplexFd;
  /**
   * An in-flight `duplex.readLine()` that has not yet been CONSUMED. Cached so a
   * `read -u N -t T` whose timer wins the `Promise.race` does NOT abandon the
   * line it started reading: the next `read -u N` reuses this same promise (and
   * the line it eventually yields), instead of starting a fresh `readLine()`
   * that would race the abandoned one over the same duplex fd. One reader at a
   * time per fd, so a single cached promise suffices. Cleared only when a reader
   * actually consumes the resolved value (see `Executor.consumeFdLine`).
   */
  pendingRead?: Promise<string | undefined>;
}

export interface Job {
  id: number;
  pids: number[];
  command: string;
  state: 'running' | 'done' | 'stopped';
  exitCode?: number;
  /** Resolves with the job's exit code when the backgrounded work finishes. */
  promise?: Promise<number>;
}

/**
 * D3: a per-command I/O context. The executor THREADS this through the exec call
 * chain instead of mutating shared instance fields, so a backgrounded statement
 * carries its OWN sinks/stdin/fd-table and a foreground command's redirect (or a
 * `$(...)` capture) installed AFTER the bg job parked can never re-route the bg
 * producer's bytes — the old shared-mutable-field design's data race.
 *
 *   - `stdout` / `stderr`: where this command's output goes (a terminal sink, a
 *     redirect file sink, a pipeline-stage capture buffer, or a cmd-sub buffer).
 *   - `stdin`: an inherited compound-pipeline stage's piped stdin (was the
 *     `pipeStdin` instance field); `undefined` ⇒ none.
 *   - `fdTable`: the numbered file-descriptor table (`exec N>file`, `>&N`, coproc
 *     fds). A child context that must isolate fd mutations (a background job)
 *     gets a COPY; nested foreground contexts share the parent's table (so
 *     `exec 3>f` persists, matching bash).
 *
 * Derive a child context with {@link Executor.deriveIo}. A `fork:true` derive
 * (background jobs / subshells) snapshots the fd-table so the child's redirects
 * do not leak back into the parent's live table.
 */
export interface CommandIO {
  stdout: OutputSink;
  stderr: OutputSink;
  stdin: ReadableStream<Uint8Array> | undefined;
  fdTable: Map<number, FdEntry>;
}

/** Mutable shell state carried across statements. */
export interface ShellContext {
  cwd: string;
  env: Record<string, string>;
  /** Positional parameters $1..$N ($0 is `name`). */
  positional?: string[];
  /** $0 — the shell/script name. */
  name?: string;
  /** Shell PID for `$$`. */
  pid?: number;
  /**
   * True for an interactive shell (a REPL front-end feeding one line per
   * `exec()`). bash enables history expansion (`!!`, `!n`) only when interactive;
   * a non-interactive shell (`-c`, a script, the default here) leaves it OFF so a
   * bare `!` in `$((!x))` / `[ ! x ]` / `!cmd` negation is never a history event.
   */
  interactive?: boolean;
}

export type CommandResolver = (name: string) => string | URL | undefined;

export interface ExecutorOptions {
  resolve?: CommandResolver;
  onStdout?: OutputSink | ((s: string) => void);
  onStderr?: OutputSink | ((s: string) => void);
  fs?: FsClient;
  /**
   * The shell's OWN stdin as a LIVE byte stream, installed as the root frame's
   * `stdin`. `read`/`cat`/`mapfile` consume it through the frame's shared
   * {@link StdinReader} (a `read -t` over a stream with no data yet times out);
   * here-docs / `<<<` / `< file` install their own byte stream on the frame.
   * Absent ⇒ the root frame has no stdin (plain `read` returns EOF).
   */
  stdinStream?: ReadableStream<Uint8Array>;
}

class ShellExit extends Error {
  code: number;
  constructor(code: number) { super('exit'); this.code = code; }
}
class LoopBreak extends Error {
  count: number;
  constructor(count: number) { super('break'); this.count = count; }
}
class LoopContinue extends Error {
  count: number;
  constructor(count: number) { super('continue'); this.count = count; }
}
class FuncReturn extends Error {
  code: number;
  constructor(code: number) { super('return'); this.code = code; }
}
/** A redirect that cannot be performed (e.g. noclobber refusing to overwrite). */
class RedirectError extends Error {}

/**
 * Yield to the MACROTASK queue (not just microtasks). An in-process producer loop
 * (`while :; do echo x; done | head`) writes to a {@link sinkToStream} sink whose
 * broken-pipe signal only arrives as a MessagePort message — a macrotask. A loop
 * that awaits only already-resolved promises (microtasks) starves that macrotask
 * forever, so the downstream's early close (EPIPE) is never delivered and the
 * producer never learns to stop (RSS grows unbounded). Turning the event loop once
 * per batch of iterations lets the pump process the close and latch the sink broken,
 * so the next `ctx.write` throws {@link BrokenPipeError} — the SIGPIPE-equivalent
 * unwind. Isomorphic (`setTimeout(0)` works in the browser and on Node).
 */
const YIELD_EVERY = 128;
const yieldToIo = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/**
 * A frame-scoped {@link StdinReader}, cached on a {@link CommandIO} under this
 * symbol so every builtin dispatched against the same frame shares ONE cursor
 * (sequential `read`/`cat`/`mapfile` advance the same stream position).
 */
const STDIN_READER = Symbol('stdinReader');

/**
 * A frame-scoped cache for an in-flight `readLine()` a prior `read -t` started
 * but abandoned when its timer won. The NEXT plain `read` reuses this SAME
 * promise (and the line it eventually yields) instead of starting a fresh read
 * that would race the orphan — which would drop the orphan's line (the reader's
 * chunk cursor has already advanced past it). Cleared on consumption. Mirrors the
 * duplex-fd `pendingRead` cache.
 */
const STDIN_PENDING_LINE = Symbol('stdinPendingLine');

/** A one-shot ReadableStream over a fixed byte buffer. */
function bytesStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { if (data.byteLength > 0) controller.enqueue(data); controller.close(); },
  });
}

export class Executor {
  readonly context: ShellContext;
  /** C4: the variable environment (vars/arrays/assoc/RANDOM/SHLVL) — the ShellEnv. */
  private environment: Environment;
  private kernel: KernelClient;
  private resolve: CommandResolver;
  private fs: FsClient | undefined;
  /**
   * The shell's OWN live stdin byte stream (the root frame's stdin). A BUILTIN
   * reads it incrementally via the frame's StdinReader, but the shell must NOT
   * drain it to feed an EXTERNAL command's fd-0 (that would block on a never-EOF
   * terminal stdin and steal bytes a later `read` wants). External commands
   * inherit stdin through the kernel's default wiring instead — so this exact
   * stream is skipped in {@link resolveStdinFd}'s inherited-stdin case. A finite
   * pipeline-captured stream (a different object) is still drained normally.
   */
  private rootStdinStream: ReadableStream<Uint8Array> | undefined;
  /**
   * fds aliased via `<&N` (input fd-dup) by a command currently in scope, so a
   * plain `read` sources fd 0 from the alias — distinct from a stale fd-0 entry
   * left by an ambient `exec 0<file`. A DEPTH COUNT (not a flat set): a nested
   * `<&` on the SAME fd (e.g. `{ read a <&4; read b; } <&3` — both default fd 0)
   * increments on apply and decrements on restore, so the inner command's restore
   * does not tear down the outer command's still-live alias (mark present while
   * count > 0). Populated in `applyRedirects`, decremented by its restore closure.
   */
  private stdinDupFds = new Map<number, number>();
  private lastStatus = 0;
  private pipeStatus: number[] = [];
  /** 1-based source line of the statement currently executing, for `$LINENO`. */
  private currentLine = 0;
  /** C4: the job table + wait/jobs/kill/disown owner. */
  private jobControl: JobController;
  /** Status of the most recent command substitution (`$(...)`), for M10. */
  private lastCmdSubStatus: number | undefined;
  private exiting: number | undefined;
  /**
   * D3: the AMBIENT per-command I/O context. Synchronous helpers and the
   * Expander→`$(...)` boundary read it; the async exec chain THREADS a
   * {@link CommandIO} parameter and re-asserts it here at each method entry, so
   * a synchronous write always targets the right frame. Post-`await` writers
   * (`spawnExternal`/`writeCaptured`/`pumpToStdout`/pipeline drains) take an
   * EXPLICIT frame param so a value resolved after the foreground swapped the
   * ambient frame still lands in the original command's sinks — closing the
   * background-job sink data race.
   */
  private io: CommandIO;
  private functions = new Map<string, ShellFunction>();
  /** Indexed arrays (`arr=(a b c)`), kept separate from scalar `context.env`. */
  private arrays = new Map<string, string[]>();
  private localScopes: Array<Set<string>> = [];
  private localSaved: Array<Map<string, string | undefined>> = [];
  /**
   * Per-local-scope snapshot of a name's ARRAY / ASSOC storage (and integer/assoc
   * flags) at the point `local NAME` shadowed it, so a `local arr=(…)` (or `read
   * -a`, `declare -A` in a function) is restored on function exit and does not leak
   * to the caller. Keyed by name; `undefined` value ⇒ the name had no array before.
   */
  private localSavedArrays: Array<Map<string, {
    arr?: string[]; assoc?: Map<string, string>; integer: boolean; readonly: boolean; nameref?: string;
  }>> = [];
  /** Names marked `readonly` — reassigning one is rejected (fatal in POSIX mode). */
  private readonlyNames = new Set<string>();
  /** Names declared `declare -i` (integer): assignments are arithmetic-evaluated. */
  private integerNames = new Set<string>();
  /** `$BASH_REMATCH` capture groups from the last successful `[[ =~ ]]` match. */
  private bashRematch: string[] = [];
  /** `$_` — the last argument (post-expansion) of the previous simple command. */
  private lastArgValue = '';
  /** Shell start time (ms) for `$SECONDS`; `Date.now()` is only used at read time. */
  private startTimeMs = Date.now();
  /** `declare -n ref=target` namerefs (ref → target). Single-level only. */
  private namerefs = new Map<string, string>();
  /** Directory stack BELOW cwd (most-recent-first) for `pushd`/`popd`/`dirs`. */
  private dirStackBelow: string[] = [];
  /** `set` options. errexit aborts on nonzero; the rest per their POSIX meaning. */
  private options: Record<ShellOptionName, boolean> = {
    errexit: false,
    nounset: false,
    xtrace: false,
    pipefail: false,
    noclobber: false,
    verbose: false,
    posix: false,
    // History expansion (`!!`, `!n`, ...) — bash enables `histexpand` ONLY for
    // interactive shells; a non-interactive shell (`-c`, a script, and every
    // sandbox `exec()` here) has it OFF, so a bare `!` in `$((!x))`/`[ ! x ]`/`!cmd`
    // negation is never mistaken for an event. An interactive REPL front-end can
    // opt in with `set -H` (M13).
    histexpand: false,
  };
  /** `shopt` bash options (extglob/globstar/nullglob/dotglob/nocaseglob/nocasematch). */
  private shoptStore: Record<string, boolean> = {
    dotglob: false, extglob: false, globstar: false,
    nocaseglob: false, nocasematch: false, nullglob: false,
  };
  /** Trap handlers: signal name (EXIT/ERR/INT/DEBUG/RETURN/...) → handler command string. */
  private traps = new Map<string, string>();
  /** True while a DEBUG trap action is running, so it does not recurse into itself. */
  private inDebugTrap = false;
  /** Function-call name stack for `$FUNCNAME` (most-recent first at index 0). */
  private funcStack: string[] = [];
  /** Command history (most-recent-last). */
  private historyLines: string[] = [];
  /**
   * Per-shell PERSISTENT numbered file-descriptor table (fd → sink/source), for
   * `exec N>file` / `>&N`. The ambient {@link io} frame's `fdTable` references
   * THIS for foreground commands (so `exec` redirects persist); a forked
   * (background / subshell) frame gets a snapshot copy via {@link deriveIo}.
   */
  private fdTable = new Map<number, FdEntry>();
  /** Monotonic counter for process-substitution temp file names. */
  private procSubSeq = 0;
  /** Deferred `>(cmd)` process substitutions to run after the current command. */
  private pendingProcSubs: Array<{ path: string; src: string }> = [];
  /** Associative arrays (`declare -A`): name → string-keyed map (G6). Insertion-ordered. */
  private assocArrays = new Map<string, Map<string, string>>();

  constructor(kernel: KernelClient, context: ShellContext, options: ExecutorOptions = {}) {
    this.kernel = kernel;
    this.context = context;
    // History expansion follows interactivity (bash): ON for an interactive REPL,
    // OFF for a non-interactive shell (scripts / `-c` / the default).
    if (context.interactive) this.options.histexpand = true;
    this.resolve = options.resolve ?? ((name) => name);
    this.fs = options.fs;
    this.rootStdinStream = options.stdinStream;
    const stdout = toSink(options.onStdout ?? ((s: string) => {
      if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
    }));
    const stderr = toSink(options.onStderr ?? ((s: string) => {
      if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s);
    }));
    // The root ambient frame: terminal sinks, the shell's live stdin byte stream
    // (its frame-scoped StdinReader is created lazily), the persistent fd table.
    this.io = { stdout, stderr, stdin: options.stdinStream, fdTable: this.fdTable };
    // C4: the job table + wait/jobs/kill/disown owner (signal delivery via kernel.kill).
    this.jobControl = new JobController(kernel.kill ? (pid, sig) => kernel.kill!(pid, sig) : undefined);
    // C4: the variable environment. The Executor is the EnvHost — it supplies the
    // status/positional specials and the cross-cutting glob / cmd-sub / flag
    // accessors so Environment stays a focused variable store.
    const host: EnvHost = {
      lastStatus: () => this.lastStatus,
      lastBgPid: () => this.jobControl.lastBgPid(),
      pipeStatus: () => this.pipeStatus,
      currentLine: () => this.currentLine,
      currentFlags: () => this.currentFlags(),
      arrays: () => this.arrays,
      assocArrays: () => this.assocArrays,
      nounset: () => this.options.nounset,
      posix: () => this.options.posix,
      shopt: (n) => this.shoptStore[n] ?? false,
      runCommandSub: (s) => this.runCommandSub(s),
      listDir: (p) => this.listDir(p),
      statPath: (p) => this.statPath(p),
      procSub: (s, d) => this.procSub(s, d),
      resolveNameref: (n) => this.namerefs.get(n),
      attrFlags: (name) => {
        // bash `${var@a}`: attribute-type letter (A assoc / a indexed) then `n`
        // (nameref) then `r` (readonly). Single-attribute cases are unambiguous.
        let f = '';
        if (this.assocArrays.has(name)) f += 'A';
        else if (this.arrays.has(name)) f += 'a';
        if (this.integerNames.has(name)) f += 'i';
        if (this.namerefs.has(name)) f += 'n';
        if (this.readonlyNames.has(name)) f += 'r';
        return f;
      },
      isReadonly: (name) => this.readonlyNames.has(name),
      // The expander's `${var:=x}` readonly warning routes here; mirror the other
      // readonly diagnostics' `shell: ` prefix and the current stderr frame.
      warn: (msg) => this.io.stderr(`shell: ${msg}\n`),
      funcNameStack: () => this.funcStack,
      bashRematch: () => this.bashRematch,
      lastArg: () => this.lastArgValue,
      secondsElapsed: () => Math.floor((Date.now() - this.startTimeMs) / 1000),
    };
    this.environment = new Environment(this.context, host);
    // $SHLVL: derive from the inherited value and store it back (G7).
    const inherited = parseInt(this.context.env.SHLVL ?? '', 10);
    this.context.env.SHLVL = String(computeShlvl(Number.isNaN(inherited) ? 0 : inherited));
  }

  /**
   * Process substitution (M4). For `<(cmd)`: run `cmd`, write its stdout to a
   * temp VFS file, and return that path (the surrounding command reads it). For
   * `>(cmd)`: return a temp path now and QUEUE `cmd` to run after the current
   * simple command finishes, feeding it the file's contents as stdin. Requires
   * an FsClient; without one the path is a `/dev/null`-ish placeholder.
   */
  async procSub(src: string, dir: 'in' | 'out'): Promise<string> {
    const path = `/tmp/.mithic-procsub-${this.procSubSeq++}`;
    if (!this.fs) return '/dev/null';
    if (dir === 'in') {
      const out = await this.runCommandSubRaw(src);
      const fd = this.fs.fsOpen(path, { write: true, create: true, truncate: true });
      this.fs.fsWrite(fd, out);
      this.fs.fsClose(fd);
    } else {
      // Create the empty sink file; defer running `cmd` until the outer command
      // has written to it.
      const fd = this.fs.fsOpen(path, { write: true, create: true, truncate: true });
      this.fs.fsWrite(fd, '');
      this.fs.fsClose(fd);
      this.pendingProcSubs.push({ path, src });
    }
    return path;
  }

  /**
   * The stdin stream a `$(…)` / `<(…)` capture frame inherits from the ambient
   * frame: the ambient stdin so an inner `$(cat)` reads the enclosing command's
   * input (bash), EXCEPT the shell's never-EOF ROOT stdin — reading that whole
   * would hang, so it is treated as no input (EOF). Mirrors `execSelect`'s guard.
   */
  private inheritedSubStdin(): ReadableStream<Uint8Array> | undefined {
    return this.io.stdin === this.rootStdinStream ? undefined : this.io.stdin;
  }

  /** Run a command-sub body WITHOUT trailing-newline stripping (for procsub files). */
  private async runCommandSubRaw(src: string): Promise<string> {
    let out = '';
    // Capture into a derived child frame; stderr/fd-table AND stdin inherit the
    // ambient frame, so a `$(cat)` inside the enclosing command reads THAT
    // command's stdin (bash) — e.g. `echo x | { echo "got=$(cat)"; }` → `got=x`.
    // Never inherit the never-EOF ROOT stdin, though: a `$(cat)` expanded at the
    // shell's root frame (e.g. `echo "$(cat)" < /dev/null`, the top-level
    // all-builtin pipeline fast-path frame) would read forever — treat root as
    // no input (EOF), the same guard `execSelect` uses.
    const capIo = this.deriveIo(this.io, { stdout: (s) => { out += s; }, stdin: this.inheritedSubStdin() });
    await this.run(this.parseSrc(src), true, capIo);
    return out;
  }

  /** Flush deferred `>(cmd)` process substitutions: feed each temp file to its cmd. */
  private async flushPendingProcSubs(): Promise<void> {
    if (this.pendingProcSubs.length === 0 || !this.fs) return;
    const pending = this.pendingProcSubs;
    this.pendingProcSubs = [];
    const enc = new TextEncoder();
    for (const { path, src } of pending) {
      let data = '';
      try { data = await Promise.resolve(this.fs.fsRead(this.fs.fsOpen(path, { read: true }))); } catch { data = ''; }
      const subIo = this.deriveIo(this.io, { stdin: bytesStream(enc.encode(data)) });
      await this.run(this.parseSrc(src), true, subIo);
    }
  }

  /** Glob options for case/`[[ ]]` matching: extglob + nocasematch; `*` crosses `/`. */
  private globMatchOpts(): GlobOptions {
    return { extglob: this.shoptStore.extglob, nocase: this.shoptStore.nocasematch, pathSegment: false };
  }

  /** The short-flag letters of currently-enabled options, for `$-`. */
  private currentFlags(): string {
    let s = '';
    for (const [ch, long] of Object.entries(OPTION_FLAGS)) {
      if (this.options[long]) s += ch;
    }
    return s;
  }

  /** Parse a script string honoring the current POSIX mode. */
  private parseSrc(src: string): Program {
    return parse(src, { posix: this.options.posix });
  }

  /** Set a shell option (used by the CLI front-end before running). */
  setOption(name: ShellOptionName, value: boolean): void {
    this.options[name] = value;
    this.syncShellOpts();
  }

  /** Read a shell option (used by the CLI front-end). */
  getOption(name: ShellOptionName): boolean {
    return this.options[name];
  }

  /** Enable a shopt option (used by the CLI front-end / tests). */
  setShopt(name: string, value: boolean): void {
    if (name in this.shoptStore) { this.shoptStore[name] = value; this.syncBashOpts(); }
  }

  /**
   * `source FILE [args]` — read FILE from the VFS and execute it in the current
   * shell (sharing env/functions). Positional params are temporarily replaced by
   * the supplied args (bash semantics). Returns the sourced script's status.
   */
  async sourceFile(args: string[]): Promise<number> {
    const file = args[0];
    if (file === undefined) { this.writeStderr('shell: source: filename argument required\n'); return 2; }
    const fs = this.fs;
    if (!fs) { this.writeStderr(`shell: source: ${file}: cannot read\n`); return 1; }
    let content: string;
    try {
      const path = file.startsWith('/') ? file : this.absPath(file);
      content = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true })));
    } catch {
      this.writeStderr(`shell: source: ${file}: No such file or directory\n`);
      return 1;
    }
    const savedPositional = this.context.positional;
    if (args.length > 1) this.context.positional = args.slice(1);
    try {
      return await this.run(this.parseSrc(content), /*nested*/ true);
    } catch (e) {
      if (e instanceof FuncReturn) return e.code; // `return N` ends the sourced script
      throw e;
    } finally {
      this.context.positional = savedPositional;
    }
  }

  /**
   * Run a trap handler for the given signal name (EXIT/ERR/INT/...), if one is
   * registered. Handlers are parsed + executed in the current shell. Errors in
   * the handler are swallowed (a trap must not abort the shell).
   */
  async runTrap(signal: string): Promise<void> {
    const handler = this.traps.get(signal);
    if (!handler) return;
    try { await this.run(this.parseSrc(handler), /*nested*/ true); }
    catch { /* trap handler errors are non-fatal */ }
  }

  private async execSelect(stmt: Statement, io: CommandIO): Promise<number> {
    // `select VAR in WORDS; do BODY; done` (G1). No interactive TTY here, so we
    // read the menu choice from stdin (a `<` redirect or an upstream pipe), the
    // same source `read` uses. Per iteration: print the numbered menu + the
    // $PS3 prompt to stderr, read a line, set REPLY to the raw line and VAR to
    // the selected word (empty for a non-numeric/out-of-range choice), then run
    // the body. Loop until EOF or `break`. An empty (blank) line re-shows the
    // menu without running the body (bash semantics).
    const exp = this.expander();
    let words: string[];
    if (stmt.words === undefined) words = this.environment.getPositional();
    else { words = []; for (const w of stmt.words) words.push(...await exp.expandWord(w)); }

    const ps3 = this.context.env.PS3 ?? '#? ';
    // Drain the menu input. Never `readAll` the ROOT live stdin (a never-EOF
    // terminal) — that would hang; an interactive `select` cannot be served by a
    // whole-input read here, so treat the bare-root case as no input (EOF).
    const redirStream = await this.resolveStdinStream(stmt.redirects ?? []);
    const stream = redirStream ?? (io.stdin === this.rootStdinStream ? undefined : io.stdin);
    const input = stream ? new TextDecoder().decode(await new StdinReader(stream).readAll()) : '';
    const lines = input.length > 0 ? input.split('\n') : [];
    // A trailing newline yields a final empty element; drop it so it isn't read
    // as a (blank) selection.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const printMenu = (): void => {
      for (let k = 0; k < words.length; k++) io.stderr(`${k + 1}) ${words[k]}\n`);
    };

    let status = 0;
    let cursor = 0;
    let needMenu = true;
    for (;;) {
      if (needMenu) { printMenu(); needMenu = false; }
      io.stderr(ps3);
      if (cursor >= lines.length) break; // EOF
      const reply = lines[cursor++];
      this.context.env.REPLY = reply;
      if (reply.trim() === '') { needMenu = true; continue; } // blank line re-shows menu
      const n = parseInt(reply.trim(), 10);
      this.context.env[stmt.varName!] = (Number.isInteger(n) && n >= 1 && n <= words.length)
        ? words[n - 1] : '';
      try {
        status = await this.execList(stmt.body ?? [], io);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); continue; }
        throw e;
      }
      if (this.exiting !== undefined) return status;
    }
    return status;
  }

  async runCommandSub(src: string): Promise<string> {
    let out = '';
    // Capture into a derived child frame (stderr/fd-table AND stdin inherit the
    // ambient frame, so a `$(cat)` reads the enclosing command's stdin, matching
    // bash — but never the never-EOF ROOT stdin, which would hang; see
    // `inheritedSubStdin`). `run` saves+restores `this.io`, so the ambient frame
    // is intact afterward — and the capture buffer cannot be re-routed by an
    // interleaving foreground statement (D3).
    const capIo = this.deriveIo(this.io, { stdout: (s) => { out += s; }, stdin: this.inheritedSubStdin() });
    // `$(< file)` fast-read form (M5): an empty command body whose only content
    // is a single `< file` input redirect reads the file directly.
    const fast = src.match(/^\s*<\s*(\S+)\s*$/);
    if (fast) {
      this.lastCmdSubStatus = await this.readFileForCmdSub(fast[1], capIo);
    } else {
      this.lastCmdSubStatus = await this.run(this.parseSrc(src), /*nested*/ true, capIo);
    }
    return out;
  }

  /** Read a file for `$(< file)`, writing its contents to the (captured) sink. Returns status. */
  private async readFileForCmdSub(rawPath: string, io: CommandIO): Promise<number> {
    const path = await this.expander().expandToString(rawPath);
    const fs = this.fs;
    if (!fs) return 1;
    try {
      const data = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true })));
      io.stdout(data);
      return 0;
    } catch {
      io.stderr(`shell: ${path}: No such file or directory\n`);
      return 1;
    }
  }

  async listDir(path: string): Promise<string[] | undefined> {
    if (!this.fs?.fsReaddir) return undefined;
    try { return await this.fs.fsReaddir(path); }
    catch { return undefined; }
  }

  async statPath(path: string): Promise<{ dir: boolean } | undefined> {
    if (!this.fs?.fsStat) return undefined;
    try { const s = await this.fs.fsStat(path); return s ? { dir: s.dir } : undefined; }
    catch { return undefined; }
  }

  /**
   * Resolve a command NAME to its executable path via a `$PATH` VFS walk — backs
   * `type`/`command -v`. Mirrors the kernel's `resolveName` but over the shell's
   * injected async {@link FsClient} (no kernel import; layering preserved). An
   * explicit path (`/`, `./`, `../`) is stat-checked directly; a bare name is
   * searched across `$PATH` dirs (empty PATH ⇒ no dirs ⇒ no hit, like bash). The
   * first entry that exists AND is not a directory wins. `undefined` when the FS
   * has no `fsStat` (minimal/mock client) or nothing matches. Advisory only — this
   * reports resolution; the kernel still owns spawn-time resolution.
   */
  private async resolveExternalPath(name: string): Promise<string | undefined> {
    if (!this.fs?.fsStat) return undefined;
    const isFile = async (p: string): Promise<boolean> => {
      const s = await this.statPath(p);
      return s !== undefined && !s.dir;
    };
    if (name.startsWith('/') || name.startsWith('./') || name.startsWith('../')) {
      const p = this.absPath(name);
      return (await isFile(p)) ? p : undefined;
    }
    // bash falls back to a compiled-in default PATH when PATH is entirely UNSET (but
    // an explicitly EMPTY PATH="" means "no search dirs"). Match that distinction.
    const pathVar = this.context.env.PATH ?? '/usr/bin:/bin';
    for (const dir of pathVar.split(':')) {
      if (dir === '') continue; // empty segment: bash does NOT search cwd for a bare name
      const p = (dir.endsWith('/') ? dir.slice(0, -1) : dir) + '/' + name;
      if (await isFile(p)) return p;
    }
    return undefined;
  }

  private expander(): Expander { return new Expander(this.environment); }

  /**
   * The frame-scoped {@link StdinReader} for `io`'s stdin stream, created (and
   * cached on the frame) on first use so every builtin dispatched against this
   * frame shares ONE cursor — `{ read a; read b; } < file` reads successive data
   * and `cat`/`mapfile` drain from where an earlier `read` left off. `undefined`
   * when the frame has no stdin stream.
   */
  private stdinReaderFor(io: CommandIO): StdinReader | undefined {
    if (!io.stdin) return undefined;
    const holder = io as CommandIO & { [STDIN_READER]?: StdinReader };
    return holder[STDIN_READER] ??= new StdinReader(io.stdin);
  }

  /**
   * Whether a frame-scoped {@link StdinReader} has ALREADY been created for `io`
   * (i.e. a sibling builtin has locked `io.stdin` and advanced the shared cursor).
   * Used by the external-command stdin routing: it may hand the RAW inherited
   * stream to `spawnStream` only when NO reader exists yet — else the stream is
   * locked and must be drained through the shared reader instead (bytes path),
   * preserving the one-cursor contract (`{ read h; head; } < file`).
   */
  private stdinReaderExists(io: CommandIO): boolean {
    return (io as CommandIO & { [STDIN_READER]?: StdinReader })[STDIN_READER] !== undefined;
  }

  /** Drop the cached reader when a frame's stdin stream is replaced (used when a
   *  compound statement installs a `< file` redirect on its frame). */
  private resetStdinReader(io: CommandIO): void {
    const holder = io as CommandIO & { [STDIN_READER]?: StdinReader; [STDIN_PENDING_LINE]?: Promise<string | undefined> };
    // Clear BOTH the cached reader AND any in-flight pending-line promise bound to
    // it — else a `read -t` timeout that parked a pending line on this frame could
    // reuse the stale promise against a freshly-installed stdin stream.
    delete holder[STDIN_READER];
    delete holder[STDIN_PENDING_LINE];
  }

  // ── ShellState (for builtins that need richer state) ────────────────────────

  private shellState(): ShellState {
    return {
      functions: this.functions,
      jobs: this.jobControl.list(),
      positional: this.context.positional ?? [],
      setPositional: (p) => { this.context.positional = p; },
      shiftPositional: (n) => {
        const p = this.context.positional ?? [];
        this.context.positional = p.slice(n);
      },
      declareLocal: (name) => this.declareLocal(name),
      declareAssoc: (name) => {
        if (!this.assocArrays.has(name)) this.assocArrays.set(name, new Map());
        // An associative declaration shadows any prior scalar/indexed value.
        delete this.context.env[name];
        this.arrays.delete(name);
      },
      setArray: (name, values) => {
        // Mirror the bare `name=(a b c)` assignment path so `read -a` / `mapfile`
        // values are seen by ${name[i]}/${name[@]}/${#name[@]} expansion. Like a
        // bare assignment, this is GLOBAL — `read -a` inside a function does NOT
        // create a local (bash), so it must NOT go through declareLocal.
        this.arrays.set(name, values);
        delete this.context.env[name];
      },
      waitJob: (id) => this.jobControl.waitJob(id),
      waitAll: () => this.jobControl.waitAll(),
      waitNext: () => this.jobControl.waitNext(),
      setErrExit: (v) => { this.options.errexit = v; },
      setOption: (name, value) => {
        this.options[name] = value;
        if (name === 'errexit' || name === 'pipefail' || name === 'posix' || name === 'verbose' || name === 'xtrace' || name === 'noclobber' || name === 'nounset') this.syncShellOpts();
      },
      getOption: (name) => this.options[name],
      listOptions: () => SET_O_OPTIONS.map((k) => [k, this.options[k]] as [ShellOptionName, boolean]),
      setShopt: (name, value) => {
        if (!(name in this.shoptStore)) return false;
        this.shoptStore[name] = value; this.syncBashOpts(); return true;
      },
      getShopt: (name) => (name in this.shoptStore ? this.shoptStore[name] : undefined),
      setTrap: (signal, handler) => {
        if (handler === undefined) this.traps.delete(signal);
        else this.traps.set(signal, handler);
      },
      listTraps: () => [...this.traps.entries()],
      history: {
        list: () => this.historyLines,
        add: (line) => this.addHistory(line),
        clear: () => { this.historyLines = []; },
      },
      removeJob: (spec) => this.jobControl.remove(spec),
      killJob: (spec, signal) => this.jobControl.killJob(spec, signal),
      markReadonly: (name) => { this.readonlyNames.add(name); },
      isReadonly: (name) => this.readonlyNames.has(name),
      unsetVar: (name, index) => this.unsetVar(name, index),
      markInteger: (name) => { this.integerNames.add(name); },
      isInteger: (name) => this.integerNames.has(name),
      declareP: (names) => this.declareP(names),
      setNameref: (ref, target) => { this.namerefs.set(ref, target); },
      resolveNameref: (name) => this.namerefs.get(name),
      setGlobal: (name, value) => this.setGlobal(name, value),
      dirStack: () => this.dirStackBelow,
    };
  }

  /**
   * History-expansion stage (M13). Bash runs this on each physical input line
   * BEFORE parsing when `histexpand` is on. We expand `!`-events against the
   * recorded history, processing line-by-line so a `!!` on line 2 of a script
   * can reference line 1 (a working copy is seeded from history and extended
   * with each line's text). The persistent history is recorded later by `run()`
   * via `describeStatement`; this stage only reads it.
   */
  private expandHistoryStage(src: string): string {
    if (!src.includes('!')) return src;
    const working = [...this.historyLines];
    const lines = src.split('\n');
    const expanded = lines.map((line) => {
      const out = expandHistory(line, working);
      if (line.trim() !== '') working.push(out);
      return out;
    });
    return expanded.join('\n');
  }

  /** Append a non-blank line to history, honoring HISTSIZE (default 500). */
  private addHistory(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    this.historyLines.push(line);
    const size = parseInt(this.context.env.HISTSIZE ?? '500', 10);
    const cap = Number.isFinite(size) && size >= 0 ? size : 500;
    if (this.historyLines.length > cap) this.historyLines.splice(0, this.historyLines.length - cap);
  }

  /** Rebuild $SHELLOPTS (sorted, colon-joined set -o options that are on). */
  private syncShellOpts(): void {
    const on = SET_O_OPTIONS.filter((k) => this.options[k]);
    this.context.env.SHELLOPTS = on.join(':');
  }

  /** Rebuild $BASHOPTS (sorted, colon-joined shopt options that are on). */
  private syncBashOpts(): void {
    const on = SHOPT_NAMES.filter((k) => this.shoptStore[k]);
    this.context.env.BASHOPTS = on.join(':');
  }

  /**
   * `declare -g NAME=v`: set the GLOBAL binding. If any enclosing function scope has
   * NAME as a local, its snapshot (restored on that frame's return) is updated to
   * `v` so the global surfaces afterward — WITHOUT disturbing the currently-visible
   * local value. Returns true when a shadowing local exists (the caller must not also
   * write the flat env), false when it wrote the global (flat env) directly.
   */
  private setGlobal(name: string, value: string): boolean {
    // Find the OUTERMOST scope holding NAME as a local — its snapshot is the global
    // value that will surface once every shadowing frame returns.
    for (let i = 0; i < this.localScopes.length; i++) {
      if (this.localScopes[i].has(name)) {
        this.localSaved[i].set(name, value);
        return true; // do NOT touch context.env: it holds a shadowing local's value
      }
    }
    this.context.env[name] = value; // no local shadows it → the flat env IS the global
    return false;
  }

  private declareLocal(name: string): 'fresh' | 'existing' | 'none' {
    if (this.localScopes.length === 0) return 'none';
    const scope = this.localScopes[this.localScopes.length - 1];
    const saved = this.localSaved[this.localSaved.length - 1];
    if (scope.has(name)) return 'existing';
    scope.add(name);
    saved.set(name, name in this.context.env ? this.context.env[name] : undefined);
    // Snapshot array/assoc storage + integer/readonly/nameref attributes too, so a
    // `local arr=(…)` / `local -A m` / `local -r x` / `declare -n ref` inside a
    // function is fully restored on exit and does not leak to the caller (bash:
    // locals carry their value AND their attributes).
    const savedArr = this.localSavedArrays[this.localSavedArrays.length - 1];
    savedArr.set(name, {
      arr: this.arrays.has(name) ? this.arrays.get(name)!.slice() : undefined,
      assoc: this.assocArrays.has(name) ? new Map(this.assocArrays.get(name)!) : undefined,
      integer: this.integerNames.has(name),
      readonly: this.readonlyNames.has(name),
      nameref: this.namerefs.get(name),
    });
    // A fresh local shadows the outer variable with an EMPTY, attribute-less binding
    // (bash: `local x` hides a global `x`; `local a` on a global array yields an
    // empty array). Clear the live storage now; a following `local x=v` / `-i`/`-r`
    // then sets the local's value/attributes. The snapshot above restores the outer
    // binding on function return.
    this.arrays.delete(name);
    this.assocArrays.delete(name);
    this.integerNames.delete(name);
    this.readonlyNames.delete(name);
    this.namerefs.delete(name);
    return 'fresh';
  }

  // ── program / statement execution ──────────────────────────────────────────

  async run(program: Program, nested = false, io: CommandIO = this.io): Promise<number> {
    // D3: run against the supplied frame. Saving + restoring `this.io` lets a
    // command-sub / procsub / background job pass its OWN frame without leaking
    // it back to the caller's ambient frame.
    const savedIo = this.io;
    this.io = io;
    try {
      for (const stmt of program.body) {
        if (!nested) this.addHistory(describeStatement(stmt));
        try {
          this.lastStatus = await this.execStatement(stmt, io);
        } catch (e) {
          if (e instanceof ExpansionError) {
            // `set -u` unbound var / `${v:?}` — write to stderr and abort nonzero.
            io.stderr(`shell: ${e.message}\n`);
            this.lastStatus = 1;
            if (!nested) { this.exiting = 1; return 1; }
            return 1;
          }
          if (e instanceof SyntaxError) {
            // POSIX-mode rejection / bad redirect → diagnostic + nonzero (H1/C2).
            io.stderr(`${e.message}\n`);
            this.lastStatus = 2;
            if (!nested) { this.exiting = 2; return 2; }
            return 2;
          }
          if (e instanceof PosixSpecialBuiltinError) {
            // POSIX 2.8.1: a fatal error in a special builtin (bad option, etc.)
            // aborts a non-interactive shell in POSIX mode → no further statements.
            io.stderr(`shell: ${e.message}\n`);
            this.lastStatus = e.code;
            this.exiting = e.code;
            return e.code;
          }
          // break/continue/return that reached the top level (no enclosing loop
          // or function) → diagnostic + continue, NOT an uncaught throw (M8). A
          // `return` from a SOURCED script (nested) is valid and re-thrown so
          // sourceFile can use it as the script's exit code.
          if (e instanceof LoopBreak) { io.stderr('shell: break: only meaningful in a `for\', `while\', or `until\' loop\n'); this.lastStatus = 1; continue; }
          if (e instanceof LoopContinue) { io.stderr('shell: continue: only meaningful in a `for\', `while\', or `until\' loop\n'); this.lastStatus = 1; continue; }
          if (e instanceof FuncReturn) {
            if (nested) throw e;
            io.stderr('shell: return: can only `return\' from a function or sourced script\n');
            this.lastStatus = 1; continue;
          }
          throw e;
        }
        // ERR trap: a command exiting nonzero (outside a condition) runs the ERR
        // handler. We approximate "outside a condition" by the top-level loop.
        if (this.lastStatus !== 0 && this.traps.has('ERR') && this.exiting === undefined) {
          await this.runTrap('ERR');
        }
        if (this.exiting !== undefined) return this.exiting;
        if (this.options.errexit && this.lastStatus !== 0 && !nested) {
          this.exiting = this.lastStatus;
          return this.lastStatus;
        }
      }
    } catch (e) {
      if (e instanceof ShellExit) return e.code;
      throw e;
    } finally {
      this.io = savedIo;
    }
    return this.lastStatus;
  }

  /**
   * Run a top-level program and fire the EXIT trap afterward (whether the script
   * exited explicitly or ran to EOF). Returns the final status. The shell CLI
   * front-end (process.ts) calls this rather than {@link run} directly.
   */
  async runTop(program: Program): Promise<number> {
    let code: number;
    try {
      code = await this.run(program, false);
    } finally {
      await this.runTrap('EXIT');
    }
    return code;
  }

  /**
   * Parse + run a script string as the top-level shell input, honoring the
   * current POSIX mode and firing the EXIT trap. A parse-time error (including
   * POSIX-mode rejection) is written to stderr and yields exit 2. This is the
   * entry point the CLI front-end uses.
   */
  async exec(src: string): Promise<number> {
    if (this.options.histexpand) {
      try {
        src = this.expandHistoryStage(src);
      } catch (e) {
        if (e instanceof HistoryEventNotFound) {
          this.writeStderr(`shell: ${e.message}\n`);
          this.lastStatus = 1;
          return 1;
        }
        throw e;
      }
    }
    let program: Program;
    try {
      program = this.parseSrc(src);
    } catch (e) {
      if (e instanceof SyntaxError) {
        this.writeStderr(`${e.message}\n`);
        await this.runTrap('EXIT');
        return 2;
      }
      throw e;
    }
    return this.runTop(program);
  }

  private async execStatement(stmt: Statement, io: CommandIO): Promise<number> {
    this.io = io;
    if (stmt.line !== undefined) this.currentLine = stmt.line;
    switch (stmt.type) {
      case 'Pipeline': return this.withRedirects(stmt, io, (cio) => this.execPipeline(stmt, cio));
      case 'And': {
        const l = await this.execStatement(stmt.left!, io);
        if (this.exiting !== undefined) return l;
        return l === 0 ? this.execStatement(stmt.right!, io) : l;
      }
      case 'Or': {
        const l = await this.execStatement(stmt.left!, io);
        if (this.exiting !== undefined) return l;
        return l !== 0 ? this.execStatement(stmt.right!, io) : l;
      }
      case 'If': return this.execIf(stmt, io);
      case 'While': return this.withRedirects(stmt, io, (cio) => this.execWhile(stmt, cio));
      case 'For': return this.withRedirects(stmt, io, (cio) => this.execFor(stmt, cio));
      case 'Select': return this.withRedirects(stmt, io, (cio) => this.execSelect(stmt, cio));
      case 'Case': return this.execCase(stmt, io);
      case 'Function': {
        this.functions.set(stmt.funcName!, { name: stmt.funcName!, body: stmt.funcBody! });
        return 0;
      }
      case 'Subshell': return this.execSubshell(stmt, io);
      case 'Group': return this.withRedirects(stmt, io, (cio) => this.execList(stmt.body ?? [], cio));
      case 'Coproc': return this.execCoproc(stmt, io);
      case 'Arithmetic': return this.execArithCmd(stmt);
      case 'Cond': return this.execCond(stmt);
      default: return 0;
    }
  }

  private async execList(list: Statement[], io: CommandIO): Promise<number> {
    let status = 0;
    for (const s of list) {
      status = await this.execStatement(s, io);
      this.lastStatus = status;
      if (this.exiting !== undefined) return status;
    }
    return status;
  }

  private async execIf(stmt: Statement, io: CommandIO): Promise<number> {
    const cond = await this.execList(stmt.condition ?? [], io);
    if (this.exiting !== undefined) return cond;
    if (cond === 0) return this.execList(stmt.then ?? [], io);
    if (stmt.else) return this.execList(stmt.else, io);
    return 0;
  }

  private async execWhile(stmt: Statement, io: CommandIO): Promise<number> {
    let status = 0;
    const until = stmt.until === true;
    let iter = 0;
    for (;;) {
      const cond = await this.execList(stmt.condition ?? [], io);
      if (this.exiting !== undefined) return cond;
      const enter = until ? cond !== 0 : cond === 0;
      if (!enter) break;
      try {
        status = await this.execList(stmt.body ?? [], io);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); continue; }
        throw e;
      }
      if (this.exiting !== undefined) return status;
      // Preempt so a downstream pipe's early-close (EPIPE) can be delivered and a
      // broken producer sink latched — else a tight body starves that macrotask.
      if (++iter % YIELD_EVERY === 0) await yieldToIo();
    }
    return status;
  }

  private async execFor(stmt: Statement, io: CommandIO): Promise<number> {
    if (stmt.arithFor) return this.execArithFor(stmt, io);
    let status = 0;
    const exp = this.expander();
    let words: string[];
    if (stmt.words === undefined) {
      words = this.environment.getPositional();
    } else {
      words = [];
      for (const w of stmt.words) words.push(...await exp.expandWord(w));
    }
    // A `for X in …` over a readonly `X` is a variable-assignment error: bash
    // reports `X: readonly variable` and runs no iteration. In POSIX
    // non-interactive mode it is fatal (the statement-loop aborts); otherwise
    // report to stderr and end the for-statement with status 1.
    if (this.readonlyNames.has(stmt.varName!)) {
      const msg = `${stmt.varName!}: readonly variable`;
      if (this.options.posix) throw new PosixSpecialBuiltinError(stmt.varName!, 1, msg);
      io.stderr(`shell: ${msg}\n`);
      this.lastStatus = 1;
      return 1;
    }
    let iter = 0;
    for (const word of words) {
      this.context.env[stmt.varName!] = word;
      try {
        status = await this.execList(stmt.body ?? [], io);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); continue; }
        throw e;
      }
      if (this.exiting !== undefined) return status;
      // Preempt so a downstream pipe's early-close (EPIPE) can be delivered and a
      // broken producer sink latched (see yieldToIo).
      if (++iter % YIELD_EVERY === 0) await yieldToIo();
    }
    return status;
  }

  /**
   * C-style `for (( init; cond; incr ))` (M6). Evaluates `init` once, then loops
   * while `cond` (empty ⇒ always true) is nonzero, running the body and then
   * `incr`. Uses the arithmetic evaluator over a live env proxy so assignments
   * persist. A safety cap prevents a runaway non-terminating loop.
   */
  private async execArithFor(stmt: Statement, io: CommandIO): Promise<number> {
    let status = 0;
    // Track refused readonly writes so a counter that can never advance breaks
    // the loop instead of spinning to the 1M guard. bash infinite-loops here
    // (the readonly assignment fails every iteration); mithic is SAFER and stops.
    const rejected = new Set<string>();
    const env = this.arithEnvForExpr(rejected);
    const arr = this.arithArrayAccessExec();
    if (stmt.arithInit) evalArith(stmt.arithInit, env, arr);
    if (rejected.size > 0) return 1; // init targeted a readonly var → cannot start
    const cond = stmt.arithCond ?? '';
    let guard = 0;
    for (;;) {
      if (cond !== '' && evalArith(cond, env, arr) === 0n) break;
      if (++guard > 1_000_000) break;
      try {
        status = await this.execList(stmt.body ?? [], io);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); /* fall to incr */ }
        else throw e;
      }
      if (this.exiting !== undefined) return status;
      if (stmt.arithIncr) evalArith(stmt.arithIncr, env, arr);
      // A readonly increment target can never advance — break (divergence from
      // bash, which hangs). The warning was already emitted (warn-once per name).
      if (rejected.size > 0) break;
      // Preempt so a downstream pipe's early-close (EPIPE) can be delivered and a
      // broken producer sink latched (see yieldToIo).
      if (guard % YIELD_EVERY === 0) await yieldToIo();
    }
    return status;
  }

  /**
   * A live env proxy (bare-name read/write to the shell env) for arithmetic-for
   * and `let`. A write to a `readonly` variable is refused: warn ONCE per name
   * (so a non-advancing `for ((x=0;...;x++))` over a readonly counter does not
   * flood stderr) and SKIP the write, but return true so the expression still
   * yields its RHS value (bash returns the RHS even for a readonly target).
   *
   * `rejectedReadonly` collects the names whose write was refused so the caller
   * (`execArithFor`) can break a loop that can no longer make progress — a
   * deliberate divergence from bash, which infinite-loops on a readonly counter.
   */
  private arithEnvForExpr(rejectedReadonly?: Set<string>): Record<string, string> {
    const warned = new Set<string>();
    return new Proxy({}, {
      // A bare array name in arithmetic resolves to element 0 (bash): `(( a ))` == `(( a[0] ))`.
      get: (_t, p: string) => this.context.env[p] ?? this.arrays.get(p)?.[0] ?? '',
      set: (_t, p: string, v) => {
        if (this.readonlyNames.has(p)) {
          rejectedReadonly?.add(p);
          if (!warned.has(p)) { warned.add(p); this.io.stderr(`shell: ${p}: readonly variable\n`); }
          return true;
        }
        this.context.env[p] = String(v); return true;
      },
      has: (_t, p: string) => p in this.context.env || this.arrays.get(p) !== undefined,
    }) as Record<string, string>;
  }

  /**
   * Array-element accessor for `a[i]` arithmetic lvalues in `(( ))`/`let`/`declare -i`/
   * C-style `for (( ))`. A negative index counts from the end; a write creates the array.
   */
  /**
   * `unset NAME` (or `unset NAME[idx]`) — remove a variable's scalar value, its
   * indexed/associative array, and integer/nameref attributes; or, with `index`,
   * a single element (numeric for indexed, string key for assoc).
   */
  private unsetVar(name: string, index?: string): void {
    if (index !== undefined) {
      const assoc = this.assocArrays.get(name);
      if (assoc !== undefined) { assoc.delete(index); return; }
      const arr = this.arrays.get(name);
      if (arr !== undefined) {
        const i = /^-?\d+$/.test(index.trim())
          ? parseInt(index.trim(), 10)
          : (() => { try { return Number(evalArith(index, this.arithEnvForExpr(), this.arithArrayAccessExec())); } catch { return 0; } })();
        const idx = i < 0 ? arr.length + i : i;
        delete arr[idx]; // leaves a hole (bash sparse-array semantics)
      }
      return;
    }
    delete this.context.env[name];
    this.arrays.delete(name);
    this.assocArrays.delete(name);
    this.integerNames.delete(name);
    this.namerefs.delete(name);
  }

  private arithArrayAccessExec(): ArithArrayAccess {
    return {
      getElement: (name, index) => {
        const arr = this.arrays.get(name);
        if (!arr) return undefined;
        const i = index < 0 ? arr.length + index : index;
        return arr[i];
      },
      setElement: (name, index, value) => {
        if (this.readonlyNames.has(name)) { this.io.stderr(`shell: ${name}: readonly variable\n`); return; }
        const arr = this.arrays.get(name) ?? [];
        let i = index < 0 ? arr.length + index : index;
        if (i < 0) i = 0;
        arr[i] = value;
        this.arrays.set(name, arr);
      },
    };
  }

  private async execCase(stmt: Statement, io: CommandIO): Promise<number> {
    const exp = this.expander();
    const word = await exp.expandToString(stmt.caseWord!);
    const clauses = stmt.clauses ?? [];
    let status = 0;
    let i = 0;
    while (i < clauses.length) {
      const clause = clauses[i];
      let matched = false;
      for (const rawPat of clause.patterns) {
        const pat = await exp.expandToString(rawPat);
        if (globMatch(word, pat, this.globMatchOpts())) { matched = true; break; }
      }
      if (!matched) { i++; continue; }
      status = await this.execList(clause.body, io);
      // `;&` (fallthrough): run each following clause's body unconditionally
      // until a normal `;;` terminator (or the end) is reached.
      let cur = clause;
      while (cur.fallthrough && i + 1 < clauses.length) {
        i++;
        cur = clauses[i];
        status = await this.execList(cur.body, io);
      }
      // `;;&` (continue-matching): keep testing subsequent patterns.
      if (cur.continueMatch) { i++; continue; }
      break;
    }
    return status;
  }

  /**
   * Run a subshell `( … )` in an isolated execution scope. A subshell snapshots
   * AND restores env, cwd, set-options, functions, arrays, and positional
   * params, so none of its mutations leak to the parent (M2). Critically, an
   * `exit` inside the subshell ends ONLY the subshell with its code — the parent
   * continues (the standalone critical bug): we save/clear `this.exiting` across
   * the body and convert a subshell-local exit into the subshell's return code.
   * `break`/`continue`/`return` do not cross the subshell boundary either —
   * they are caught and the subshell ends with the appropriate status rather
   * than throwing uncaught into the parent.
   */
  private async execSubshell(stmt: Statement, io: CommandIO): Promise<number> {
    const savedEnv = { ...this.context.env };
    const savedCwd = this.context.cwd;
    const savedPositional = this.context.positional ? [...this.context.positional] : undefined;
    const savedOptions = { ...this.options };
    const savedShopt = { ...this.shoptStore };
    const savedFunctions = new Map(this.functions);
    const savedArrays = new Map(this.arrays);
    const savedExiting = this.exiting;
    this.exiting = undefined;
    // A subshell forks its I/O context: redirects / `exec N>f` inside it (its
    // own fd-table snapshot) must not leak back to the parent's live table.
    const subIo = this.deriveIo(io, {}, /*fork*/ true);
    try {
      // A subshell applies its OWN redirects, like Group/While/For/Select. It
      // is a COMPOUND statement, so installStdin=true installs a `< file` on the
      // forked frame (its inner commands share one cursor). A bad-file redirect
      // is non-fatal to the parent: convert the RedirectError to status 1 with no
      // command name (so onRedirectError never throws a PosixSpecialBuiltinError).
      let restore: () => void;
      try {
        restore = await this.applyRedirects(stmt.redirects ?? [], subIo, /*installStdin*/ true);
      } catch (e) {
        if (e instanceof RedirectError) return this.onRedirectError(undefined, e, subIo);
        throw e;
      }
      let status: number;
      try {
        status = await this.execList(stmt.body ?? [], subIo);
      } finally {
        restore();
      }
      // An `exit` inside the subshell sets `this.exiting`; that is the subshell's
      // own exit code and must NOT propagate to the parent.
      if (this.exiting !== undefined) status = this.exiting;
      return status;
    } catch (e) {
      // `break`/`continue`/`return` inside a subshell do not cross its boundary.
      if (e instanceof LoopBreak || e instanceof LoopContinue) return 0;
      if (e instanceof FuncReturn) return e.code;
      if (e instanceof ShellExit) return e.code;
      throw e;
    } finally {
      this.context.env = savedEnv;
      this.context.cwd = savedCwd;
      this.context.positional = savedPositional;
      this.options = savedOptions;
      this.shoptStore = savedShopt;
      this.functions = savedFunctions;
      this.arrays = savedArrays;
      this.exiting = savedExiting;
    }
  }

  private async execArithCmd(stmt: Statement): Promise<number> {
    const exp = this.expander();
    // Expand $vars in the expression, then evaluate against a live proxy.
    const expanded = await exp.expandToString('$(( ' + (stmt.expr ?? '0') + ' ))');
    const v = parseInt(expanded, 10) || 0;
    return v !== 0 ? 0 : 1; // bash: nonzero arith result → success
  }

  private async execCond(stmt: Statement): Promise<number> {
    const exp = this.expander();
    const words: string[] = [];
    for (const w of stmt.condWords ?? []) {
      // [[ ]] does not word-split, but we expand each token to a single string.
      words.push(await exp.expandToString(w));
    }
    return (await this.evalConditional(words)) ? 0 : 1;
  }

  /** Evaluate a `[[ ... ]]` expression (supports !, &&, ||, =~, -f/-d/-z/-n, comparisons). */
  private async evalConditional(words: string[]): Promise<boolean> {
    // Handle binary logical at top level (left-to-right, no precedence beyond that).
    const andIdx = words.indexOf('&&');
    if (andIdx >= 0) {
      return (await this.evalConditional(words.slice(0, andIdx)))
        && (await this.evalConditional(words.slice(andIdx + 1)));
    }
    const orIdx = words.indexOf('||');
    if (orIdx >= 0) {
      return (await this.evalConditional(words.slice(0, orIdx)))
        || (await this.evalConditional(words.slice(orIdx + 1)));
    }
    if (words[0] === '!') return !(await this.evalConditional(words.slice(1)));
    if (words.length === 3 && words[1] === '=~') {
      try {
        const m = new RegExp(words[2]).exec(words[0]);
        // On a match, populate $BASH_REMATCH (0 = whole match, N = group N); a
        // non-match clears it (bash leaves the previous value, but clearing is the
        // safer, predictable choice and matches the common test-then-read idiom).
        this.bashRematch = m ? m.map((g) => g ?? '') : [];
        return m !== null;
      } catch { return false; }
    }
    if (words.length === 3 && (words[1] === '==' || words[1] === '=')) {
      return globMatch(words[0], words[2], this.globMatchOpts());
    }
    if (words.length === 3 && words[1] === '!=') {
      return !globMatch(words[0], words[2], this.globMatchOpts());
    }
    // Inside `[[ ]]`, `<` / `>` are lexical (byte) string comparisons — NOT
    // redirections and needing no escaping (bash).
    if (words.length === 3 && words[1] === '<') return words[0] < words[2];
    if (words.length === 3 && words[1] === '>') return words[0] > words[2];
    if (words.length === 2 && words[0].startsWith('-')) {
      return this.condFileTest(words[0], words[1]);
    }
    // `[[ a -eq b ]]` numeric comparison: operands are ARITHMETIC expressions (bash),
    // so `[[ 010 -eq 8 ]]` (octal) and `[[ 0x10 -eq 16 ]]` (hex) hold — evaluated in
    // 64-bit BigInt. (`[ ]`/`test` use decimal-only operands; see testNumericCompare.)
    if (words.length === 3 && ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(words[1])) {
      const arrHook = this.arithArrayAccessExec();
      const env = this.arithEnvForExpr();
      const ev = (s: string): bigint => { try { return evalArith(s, env, arrHook); } catch { return 0n; } };
      const x = ev(words[0]), y = ev(words[2]);
      switch (words[1]) {
        case '-eq': return x === y;
        case '-ne': return x !== y;
        case '-lt': return x < y;
        case '-le': return x <= y;
        case '-gt': return x > y;
        case '-ge': return x >= y;
      }
    }
    return evalTestArgs(words);
  }

  private async condFileTest(op: string, path: string): Promise<boolean> {
    if (op === '-z') return path === '';
    if (op === '-n') return path !== '';
    const stat = await this.statPath(this.absPath(path));
    if (op === '-e') return stat !== undefined;
    if (op === '-f') return stat !== undefined && !stat.dir;
    if (op === '-d') return stat !== undefined && stat.dir;
    return false;
  }

  private absPath(p: string): string {
    if (p.startsWith('/')) return p;
    return (this.context.cwd.replace(/\/$/, '')) + '/' + p;
  }

  // ── redirects ───────────────────────────────────────────────────────────────

  /** Run `fn(io)` with the statement's compound redirects applied to a derived frame. */
  private async withRedirects(stmt: Statement, io: CommandIO, fn: (io: CommandIO) => Promise<number>): Promise<number> {
    const redirects = stmt.redirects;
    if (!redirects || redirects.length === 0) return fn(io);
    let restore: () => void;
    try {
      // installStdin=true: a compound statement has no per-command stdin
      // resolution, so its `< file` must be installed on the frame here.
      restore = await this.applyRedirects(redirects, io, /*installStdin*/ true);
    } catch (e) {
      // A compound statement (pipeline/group/loop) is never a special builtin, so
      // pass no name — a redirect error here is reported non-fatally (returns 1).
      if (e instanceof RedirectError) return this.onRedirectError(undefined, e, io);
      throw e;
    }
    try { return await fn(io); } finally { restore(); }
  }

  /**
   * Surface a {@link RedirectError}: write the diagnostic and return 1. POSIX
   * 2.8.1 — when the failing command is a SPECIAL builtin (`POSIX_SPECIAL_BUILTINS`)
   * and posix mode is on, the error is FATAL to a non-interactive shell, so throw
   * {@link PosixSpecialBuiltinError} instead; the statement-loop in {@link run}
   * catches it and aborts the script.
   */
  private onRedirectError(name: string | undefined, e: RedirectError, io: CommandIO): number {
    if (this.options.posix && name !== undefined && POSIX_SPECIAL_BUILTINS.has(name)) {
      throw new PosixSpecialBuiltinError(name, 1, e.message);
    }
    io.stderr(`shell: ${e.message}\n`);
    return 1;
  }

  /**
   * Snapshot the current write sink for a numbered fd (1=stdout, 2=stderr,
   * N=fdTable). Returns the concrete function NOW (not a live reference), so a
   * dup like `exec 3>&1` captures stdout's current target without forming a
   * self-referential loop when stdout is later redirected to fd 3.
   */
  private sinkForFd(fd: number, io: CommandIO): OutputSink {
    if (fd === 1) return io.stdout;
    if (fd === 2) return io.stderr;
    const entry = io.fdTable.get(fd);
    if (entry?.sink) return entry.sink;
    return toSink(() => { /* fd not open for writing — discard */ });
  }

  /** Point a numbered fd at a sink in `io` (temporary, for the duration of a command). */
  private setFdSink(fd: number, sink: OutputSink | ((s: string) => void), io: CommandIO): void {
    const s = toSink(sink);
    if (fd === 1) io.stdout = s;
    else if (fd === 2) io.stderr = s;
    else { const e = io.fdTable.get(fd) ?? { mode: 'write' as const }; e.sink = s; io.fdTable.set(fd, e); }
  }

  /**
   * Apply a set of redirects, returning a restore function. Supports `>` `>>`
   * `>|` `<` `<>` `<<` `<<<` `N>` `N>>` `&>` `&>>` (append, M9) `N>&M` (dup)
   * `N>&-` (close), numbered fds via the per-shell {@link fdTable}, and the
   * `/dev/null`/`/dev/stdout`/`/dev/stderr` device paths.
   */
  private async applyRedirects(redirects: Redirect[], io: CommandIO, installStdin = false): Promise<() => void> {
    const exp = this.expander();
    const savedStdout = io.stdout;
    const savedStderr = io.stderr;
    const savedStdin = io.stdin;
    const savedFds = new Map<number, FdEntry | undefined>();
    const closers: Array<() => void> = [];
    const dupInFds: number[] = []; // fds aliased via `<&` this command (cleared on restore)
    const snapshotFd = (fd: number): void => { if (fd !== 1 && fd !== 2 && !savedFds.has(fd)) savedFds.set(fd, io.fdTable.get(fd)); };
    // `/dev/stdout` / `/dev/stderr` redirect targets resolve to the frame's
    // ORIGINAL sinks (captured now), so `cmd 1>&2 2>file` and `> /dev/stdout`
    // behave like the unredirected destinations rather than chasing the live frame.
    const base: CommandIO = { stdout: savedStdout, stderr: savedStderr, stdin: io.stdin, fdTable: io.fdTable };

    for (const r of redirects) {
      if (r.op === '<' || r.op === '<<' || r.op === '<<<' || r.op === '<>') {
        // Only a COMPOUND statement (`{ …; }`, `while`, `for`) needs stdin
        // installed here — it has no per-command stdin resolution, so the redirect
        // is applied to the frame and the inner commands share it (ONE cursor via
        // the frame reader). A SIMPLE command already resolves its own stdin in
        // `execSimpleCommand` (and passes it to the builtin / external fd-0), so
        // installing again here would resolve the redirect a SECOND time (double
        // side-effect for `<<< "$(cmd)"`, double file read for `< f`). Gate on the
        // caller: `withRedirects` passes installStdin=true, execSimpleCommand false.
        if (installStdin) {
          const s = await this.resolveStdinStream([r]);
          if (s !== undefined) { io.stdin = s; this.resetStdinReader(io); }
        }
        continue;
      }

      if (r.op === '<&') {
        // Input fd-dup: `N<&M` makes fd N read from where fd M reads; `N<&-`
        // closes N. Default fd is 0 (`read <&3` aliases stdin to fd 3). We copy
        // the target's FdEntry to fd N so N's `duplex`/`input` becomes M's — then
        // a plain `read` (routed via readFdLine on fd 0, below) sources from it.
        // The per-command restore closure re-installs the prior fd N.
        const fd = r.fd ?? 0;
        snapshotFd(fd);
        const tgt = r.target === '-' ? '-' : await exp.expandToString(r.target);
        if (tgt === '-') { io.fdTable.delete(fd); continue; } // `<&-` closes fd N (not an alias — no dup mark)
        const dst = parseInt(tgt, 10);
        if (!Number.isNaN(dst)) {
          const srcEntry = io.fdTable.get(dst);
          if (srcEntry) io.fdTable.set(fd, srcEntry);
        }
        // Record that THIS command aliased `fd` via `<&`, so a plain `read`
        // sources fd 0 from it (vs a stale ambient `exec 0<` entry). Depth-counted
        // so a nested same-fd `<&` doesn't clobber an outer alias; the restore
        // closure below decrements.
        this.stdinDupFds.set(fd, (this.stdinDupFds.get(fd) ?? 0) + 1);
        dupInFds.push(fd);
        continue;
      }

      if (r.op === '>&') {
        // fd-dup: `N>&M` makes fd N write where M writes; `N>&-` closes N. The
        // target may need expansion (A2: `>&"${COPROC[1]}"` → the coproc fd).
        const fd = r.fd ?? 1;
        snapshotFd(fd);
        const tgt = r.target === '-' ? '-' : await exp.expandToString(r.target);
        if (tgt === '-') { this.setFdSink(fd, () => { /* closed */ }, io); if (fd > 2) io.fdTable.delete(fd); continue; }
        const dst = parseInt(tgt, 10);
        if (!Number.isNaN(dst)) this.setFdSink(fd, this.sinkForFd(dst, base), io);
        continue;
      }

      const fd = r.fd ?? 1;
      const path = await exp.expandToString(r.target);
      const append = r.op === '>>' || r.op === '&>>';
      // noclobber (`set -C`): a plain `>` must not overwrite an EXISTING regular
      // file. `>|` forces past it; `>>` (append) is exempt; a new file is fine.
      if (this.options.noclobber && r.op === '>' && path !== '/dev/null'
        && path !== '/dev/stdout' && path !== '/dev/stderr') {
        const stat = await this.statPath(this.absPath(path));
        if (stat !== undefined && !stat.dir) {
          throw new RedirectError(`${path}: cannot overwrite existing file`);
        }
      }
      const sink = this.makeFileSink(path, append, closers, base);
      if (r.op === '&>' || r.op === '&>>') { io.stdout = toSink(sink); io.stderr = toSink(sink); }
      else { snapshotFd(fd); this.setFdSink(fd, sink, io); }
    }

    return () => {
      for (const c of closers) c();
      io.stdout = savedStdout;
      io.stderr = savedStderr;
      io.stdin = savedStdin;
      this.resetStdinReader(io);
      for (const fd of dupInFds) { // decrement this command's `<&` alias depth (nesting-safe)
        const n = (this.stdinDupFds.get(fd) ?? 0) - 1;
        if (n > 0) this.stdinDupFds.set(fd, n); else this.stdinDupFds.delete(fd);
      }
      for (const [fd, prev] of savedFds) { if (prev === undefined) io.fdTable.delete(fd); else io.fdTable.set(fd, prev); }
    };
  }

  /**
   * Install `exec`'s redirects permanently on the per-shell fd table. Output
   * fds (`N>file`/`N>>file`) get a write sink; input fds (`N<file`/`N<>file`)
   * are buffered for `read -u N`; `N>&M` dups; `N>&-` closes. Returns 1 on a
   * missing input file (and writes a diagnostic).
   */
  private async execBuiltinRedirects(redirects: Redirect[], io: CommandIO): Promise<number> {
    const exp = this.expander();
    const fs = this.fs;
    for (const r of redirects) {
      const fd = r.fd ?? (r.op === '<' || r.op === '<>' ? 0 : 1);
      if (r.op === '>&') {
        const tgt = r.target === '-' ? '-' : await exp.expandToString(r.target);
        if (tgt === '-') { this.closeFdEntry(fd, io); io.fdTable.delete(fd); continue; }
        const dst = parseInt(tgt, 10);
        if (!Number.isNaN(dst)) { this.closeFdEntry(fd, io); io.fdTable.set(fd, { mode: 'write', sink: this.sinkForFd(dst, io) }); }
        continue;
      }
      if (r.op === '<' || r.op === '<>') {
        const path = await exp.expandToString(r.target);
        if (!fs) { io.stderr(`shell: exec: ${path}: cannot open\n`); return 1; }
        // STREAMING `<>`: when the FsClient can open a LIVE duplex fd, hold ONE
        // fd open across commands instead of buffering. This is what makes
        // `exec 3<>/dev/tcp/host/port; echo >&3; read -u 3` round-trip — the
        // buffered path eagerly drains to EOF at open (a socket has none) and
        // never flushes the write until close, which deadlocks. The duplex path
        // writes immediately and reads on demand. Regular files still take the
        // buffered path below (no `fsOpenDuplex`, or it falls through on error).
        if (r.op === '<>' && fs.fsOpenDuplex) {
          let duplex: DuplexFd;
          try {
            duplex = await Promise.resolve(fs.fsOpenDuplex(path));
          } catch (e) {
            // Connection refused / capability denied / no such device → exec fails.
            io.stderr(`shell: ${path}: ${(e as Error)?.message ?? 'cannot open'}\n`);
            return 1;
          }
          const entry: FdEntry = { mode: 'rw', duplex, sink: toSink((s) => { void Promise.resolve(duplex.write(s)); }), close: () => { void Promise.resolve(duplex.close()); } };
          io.fdTable.set(fd, entry);
          continue;
        }
        let input = '';
        if (r.op === '<' || path !== '/dev/null') {
          try { input = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true }))); }
          catch {
            if (r.op === '<>') { input = ''; /* <> creates if absent */ }
            else { io.stderr(`shell: ${path}: No such file or directory\n`); return 1; }
          }
        }
        const entry: FdEntry = { mode: r.op === '<>' ? 'rw' : 'read', input, pos: 0 };
        if (r.op === '<>') { entry.sink = this.makeFileSink(path, false, [], io); }
        io.fdTable.set(fd, entry);
        continue;
      }
      // Output: > >> >| (and &> &>> map to fd 1+2)
      const path = await exp.expandToString(r.target);
      const append = r.op === '>>' || r.op === '&>>';
      let seed = '';
      if (append && fs && path !== '/dev/null' && path !== '/dev/stdout' && path !== '/dev/stderr') {
        try { seed = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true }))); } catch { seed = ''; }
      }
      const sink = this.makeExecFileSink(path, seed, io);
      if (r.op === '&>' || r.op === '&>>') {
        io.fdTable.set(1, { mode: 'write', sink });
        io.fdTable.set(2, { mode: 'write', sink });
      } else {
        io.fdTable.set(fd, { mode: 'write', sink });
      }
    }
    return 0;
  }

  /**
   * A write sink for a persistent `exec N>file` fd. Each write flushes the full
   * accumulated buffer to the VFS (open-truncate, write, close), so the file
   * reflects current contents without holding an fd open across commands.
   * `seed` is the pre-read existing contents for append mode.
   */
  private makeExecFileSink(path: string, seed: string, io: CommandIO): OutputSink {
    if (path === '/dev/null') return toSink(() => { /* discard */ });
    if (path === '/dev/stdout') return io.stdout;
    if (path === '/dev/stderr') return io.stderr;
    const fs = this.fs;
    if (!fs) throw new Error(`shell: exec redirect to '${path}' requires an FsClient`);
    let buffer = seed;
    return toSink((s) => {
      buffer += s;
      const fd = fs.fsOpen(path, { write: true, create: true, truncate: true });
      fs.fsWrite(fd, buffer);
      fs.fsClose(fd);
    });
  }

  /** Close a numbered fd's underlying resource (e.g. a live `/dev/tcp` socket), if any. */
  private closeFdEntry(fd: number, io: CommandIO): void {
    const entry = io.fdTable.get(fd);
    if (entry?.close) { try { entry.close(); } catch { /* already closed */ } }
  }

  /** Close every open numbered fd's underlying resource. Called when the shell exits. */
  closeAllFds(): void {
    for (const fd of [...this.fdTable.keys()]) this.closeFdEntry(fd, this.io);
  }

  /** Read one line (default) from a numbered input fd, advancing its cursor. For `read -u N`. */
  private readFdLine(fd: number, io: CommandIO): string | undefined | Promise<string | undefined> {
    const entry = io.fdTable.get(fd);
    // A live duplex fd (e.g. `/dev/tcp`) reads on demand from the stream. Reuse
    // any in-flight read (one a prior `read -t` started but abandoned when its
    // timer fired) so its line is delivered to THIS reader instead of being lost
    // to an orphaned `readLine()`. The cache is cleared on CONSUMPTION, not on
    // resolution (see `consumeFdLine`) — so a timed-out read leaves it in place.
    if (entry?.duplex) {
      // A DATAGRAM fd (`/dev/udp/...`) reads ONE datagram (latin1, binary-exact)
      // rather than a `\n`-delimited line — a UDP datagram has neither `\n` nor
      // EOF, so `readLine()` would block until the `-t` timeout and mangle bytes.
      const read = entry.duplex.datagram && entry.duplex.readDatagram
        ? entry.duplex.readDatagram()
        : entry.duplex.readLine();
      const p = entry.pendingRead ?? Promise.resolve(read);
      entry.pendingRead = p;
      return p;
    }
    if (!entry || entry.input === undefined) return undefined;
    const pos = entry.pos ?? 0;
    if (pos >= entry.input.length) return undefined; // EOF
    const nl = entry.input.indexOf('\n', pos);
    const end = nl >= 0 ? nl : entry.input.length;
    const line = entry.input.slice(pos, end);
    entry.pos = nl >= 0 ? nl + 1 : entry.input.length;
    return line;
  }

  /**
   * Mark a duplex fd's in-flight `readFdLine` as consumed so the NEXT read
   * starts a fresh `readLine()`. `read -u N` calls this only when it actually
   * uses the line; on a `read -t` timeout it does NOT, leaving the in-flight
   * read cached for the next reader (no data dropped).
   */
  private consumeFdLine(fd: number, io: CommandIO): void {
    const entry = io.fdTable.get(fd);
    if (entry?.duplex) entry.pendingRead = undefined;
  }

  /**
   * Read one line of PLAIN stdin (no `-u`) for the `read` builtin, from `io`'s
   * frame-scoped {@link StdinReader}. A `-t` timeout races the pending read
   * against a timer. A timed-out read's `readLine()` promise is CACHED on the
   * frame (`STDIN_PENDING_LINE`) so the NEXT read reuses it rather than starting
   * a fresh read that would race the orphan and drop its line — the reader's
   * chunk cursor has already advanced past those bytes. The cache is cleared only
   * on CONSUMPTION. No stdin stream ⇒ EOF.
   */
  async readStdinLine(io: CommandIO, timeoutSec: number | undefined): Promise<{ line: string | undefined; timedOut: boolean }> {
    const reader = this.stdinReaderFor(io);
    if (!reader) return { line: undefined, timedOut: false };
    const holder = io as CommandIO & { [STDIN_PENDING_LINE]?: Promise<string | undefined> };
    const readP = holder[STDIN_PENDING_LINE] ?? reader.readLine();
    holder[STDIN_PENDING_LINE] = readP;
    if (timeoutSec === undefined) {
      const line = await readP;
      holder[STDIN_PENDING_LINE] = undefined; // consumed
      return { line, timedOut: false };
    }
    const timedOut = Symbol('t');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timerP = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), Math.max(0, timeoutSec * 1000)); });
    const r = await Promise.race([readP, timerP]);
    if (timer !== undefined) clearTimeout(timer);
    if (r === timedOut) return { line: undefined, timedOut: true }; // leave pending cached
    holder[STDIN_PENDING_LINE] = undefined; // consumed
    return { line: r as string | undefined, timedOut: false };
  }

  private makeFileSink(path: string, append: boolean, closers: Array<() => void>, io: CommandIO): OutputSink {
    if (path === '/dev/null') return toSink(() => { /* discard */ });
    if (path === '/dev/stdout') return io.stdout;
    if (path === '/dev/stderr') return io.stderr;
    const fs = this.fs;
    if (!fs) throw new Error(`shell: redirect to '${path}' requires an FsClient (pass 'fs' in ExecutorOptions)`);
    const fd = fs.fsOpen(path, { write: !append, append, create: true, truncate: !append });
    closers.push(() => fs.fsClose(fd));
    return toSink((s) => fs.fsWrite(fd, s));
  }

  /**
   * Resolve a command's stdin source from its input redirects (`<`, `<<`, `<<<`,
   * `<>`) into a one-shot `ReadableStream<Uint8Array>`. The LAST input redirect
   * wins (bash semantics). `undefined` when there is no input redirect. A here-doc
   * body / here-string word / file contents are byte-encoded into a fixed buffer
   * (`bytesStream`); `/dev/null` yields an empty stream (immediate EOF).
   */
  private async resolveStdinStream(redirects: Redirect[]): Promise<ReadableStream<Uint8Array> | undefined> {
    const exp = this.expander();
    const enc = new TextEncoder();
    let stream: ReadableStream<Uint8Array> | undefined;
    for (const r of redirects) {
      if (r.op === '<<<') {
        stream = bytesStream(enc.encode(await exp.expandToString(r.target) + '\n'));
      } else if (r.op === '<<') {
        const body = r.hereDocQuoted ? (r.hereDoc ?? '') : await this.expandHereDoc(r.hereDoc ?? '');
        stream = bytesStream(enc.encode(body));
      } else if (r.op === '<' || r.op === '<>') {
        const path = await exp.expandToString(r.target);
        if (path === '/dev/null') { stream = bytesStream(new Uint8Array()); continue; }
        // FIX 2: byte-safe read (fileStdinStream prefers FsClient.fsReadBytes).
        stream = await this.fileStdinStream(path, r.op === '<>');
      }
    }
    return stream;
  }

  /**
   * D8: resolve an EXTERNAL command's fd-0 (stdin) source into a kernel fd spec.
   * A `<` redirect becomes an `open` of the (cwd-resolved) path — the kernel
   * streams the file into fd 0; a `<<`/`<<<` body becomes `bytes` fed into fd 0.
   * With no input redirect, an inherited piped-stdin STREAM (from a compound-
   * pipeline stage or a `while read; do EXTERNAL; done < file` body) is drained to
   * `bytes` so it still reaches the child. It is drained through the FRAME's
   * SHARED {@link StdinReader} (not a fresh reader) so it (a) does not double-lock
   * a stream a sibling builtin/external already holds — `getReader()` throws on a
   * locked stream — and (b) advances the ONE shared cursor, so a following read
   * correctly sees EOF/remaining data. Returns undefined when there is no stdin.
   *
   * `/dev/null` resolves to an empty `bytes` spec (immediate EOF) — the kernel's
   * VFS has no `/dev/null` handle to `open`.
   */
  private async resolveStdinFd(redirects: Redirect[], io: CommandIO): Promise<StdinFdSpec | undefined> {
    const exp = this.expander();
    let spec: StdinFdSpec | undefined;
    let sawRedirect = false;
    for (const r of redirects) {
      if (r.op === '<<<') {
        sawRedirect = true;
        spec = { action: 'bytes', data: new TextEncoder().encode(await exp.expandToString(r.target) + '\n') };
      } else if (r.op === '<<') {
        sawRedirect = true;
        const body = r.hereDocQuoted ? (r.hereDoc ?? '') : await this.expandHereDoc(r.hereDoc ?? '');
        spec = { action: 'bytes', data: new TextEncoder().encode(body) };
      } else if (r.op === '<' || r.op === '<>') {
        sawRedirect = true;
        const path = await exp.expandToString(r.target);
        spec = path === '/dev/null'
          ? { action: 'bytes', data: new Uint8Array() }
          : { action: 'open', path: this.absPath(path), flags: { read: true } };
      }
    }
    if (sawRedirect) return spec;
    // No redirect: drain any inherited stdin stream through the frame's SHARED
    // reader (never a fresh reader — that would double-lock a stream a sibling
    // command in the same compound frame already holds, and `getReader()` throws
    // on a locked stream). The shell's OWN live stdin (the root stream) is NOT
    // drained — it is inherited by the child via the kernel's default fd-0 wiring,
    // and draining a never-EOF terminal would block.
    if (io.stdin !== undefined && io.stdin !== this.rootStdinStream) {
      const reader = this.stdinReaderFor(io);
      if (reader) { const data = await reader.readAll(); return { action: 'bytes', data }; }
    }
    return undefined;
  }

  /**
   * FIX 1 (item G): resolve a SIMPLE command's stdin input redirect EXACTLY ONCE
   * into BOTH forms — a `ReadableStream<Uint8Array>` (for a builtin) and a kernel
   * `StdinFdSpec` (for an external). A previous split — `resolveStdinStream` for
   * the builtin path plus `resolveStdinFd` for the external path — expanded the
   * redirect target twice, so `<<< "$(cmd)"` ran its command substitution twice.
   *
   * The LAST input redirect wins (bash). `<<<`/`<<` expand once to bytes; the
   * SAME bytes back both a `bytesStream` and an `{action:'bytes'}` fdSpec. `< file`
   * expands the path once; the builtin reads the file NOW (byte-safe when the
   * FsClient offers `fsReadBytes` — FIX 2), the external gets `{action:'open'}`
   * so the kernel streams it. `/dev/null` → an empty stream / empty-bytes spec.
   *
   * Returns `undefined` when there is NO input redirect — the caller falls back to
   * its inherited-stdin handling (builtin: `io.stdin`; external: live-stream /
   * `resolveStdinFd` drain of the frame's shared reader).
   */
  private async resolveStdinInput(
    redirects: Redirect[],
  ): Promise<{ stream: ReadableStream<Uint8Array>; fdSpec: StdinFdSpec } | undefined> {
    const exp = this.expander();
    const enc = new TextEncoder();
    let resolved: { stream: ReadableStream<Uint8Array>; fdSpec: StdinFdSpec } | undefined;
    for (const r of redirects) {
      if (r.op === '<<<') {
        const bytes = enc.encode(await exp.expandToString(r.target) + '\n');
        resolved = { stream: bytesStream(bytes), fdSpec: { action: 'bytes', data: bytes } };
      } else if (r.op === '<<') {
        const body = r.hereDocQuoted ? (r.hereDoc ?? '') : await this.expandHereDoc(r.hereDoc ?? '');
        const bytes = enc.encode(body);
        resolved = { stream: bytesStream(bytes), fdSpec: { action: 'bytes', data: bytes } };
      } else if (r.op === '<' || r.op === '<>') {
        const path = await exp.expandToString(r.target);
        if (path === '/dev/null') {
          resolved = { stream: bytesStream(new Uint8Array()), fdSpec: { action: 'bytes', data: new Uint8Array() } };
          continue;
        }
        // The external's fdSpec never reads here (the kernel streams the open path);
        // the builtin's stream reads the file NOW, byte-safe (FIX 2). A missing file
        // is a RedirectError for `<` (bash: the command never runs) — surfaced when
        // the stream is materialized below; a `<>` creates it (empty).
        const stream = await this.fileStdinStream(path, r.op === '<>');
        resolved = { stream, fdSpec: { action: 'open', path: this.absPath(path), flags: { read: true } } };
      }
    }
    return resolved;
  }

  /**
   * Read a `< file` / `<>` redirect source into a one-shot byte stream, byte-safe.
   * FIX 2 (item A): prefer the FsClient's binary-safe `fsReadBytes` (no UTF-8
   * round-trip); fall back to the string `fsRead` + re-encode when a minimal mock
   * FsClient does not implement it. `<>` on a missing file yields an empty stream
   * (it creates the file); `<` on a missing file throws {@link RedirectError}.
   */
  private async fileStdinStream(path: string, isReadWrite: boolean): Promise<ReadableStream<Uint8Array>> {
    const fs = this.fs;
    if (!fs) throw new Error(`shell: input redirect from '${path}' requires an FsClient`);
    try {
      if (fs.fsReadBytes) {
        return bytesStream(await Promise.resolve(fs.fsReadBytes(fs.fsOpen(path, { read: true }))));
      }
      const data = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true })));
      return bytesStream(new TextEncoder().encode(data));
    } catch (e) {
      if (e instanceof RedirectError) throw e;
      if (isReadWrite) return bytesStream(new Uint8Array()); // <> creates if absent
      throw new RedirectError(`${path}: No such file or directory`);
    }
  }

  private async expandHereDoc(body: string): Promise<string> {
    // Expand $vars/$() line by line but keep newlines verbatim.
    const exp = this.expander();
    const out: string[] = [];
    for (const line of body.split('\n')) {
      out.push((await exp.substituteOnly(line)));
    }
    return out.join('\n');
  }

  // ── pipelines / simple commands ──────────────────────────────────────────────

  private async execPipeline(stmt: Statement, io: CommandIO): Promise<number> {
    // General compound-stage pipeline (M1/H8): any stage may be a compound
    // command, and `|&` may funnel stderr. Run stages in-process, capturing each
    // stage's stdout (and optionally stderr) as the next stage's stdin.
    if (stmt.stageNodes && stmt.stageNodes.length > 0) {
      if (stmt.background) return this.execBackground(stmt, io);
      // D5-fix: if EVERY compound-stage reduces to a single simple command and no
      // `|&` join is present, flatten to a flat-`stages` pipeline so it runs
      // through the CONCURRENT kernel path (execMultiStagePipeline → runPipeline),
      // which streams stage-to-stage and propagates EPIPE. This is what makes
      // `yes | { head -n3; }` TERMINATE instead of hard-hanging: the serialized
      // in-process execNodePipeline buffers stage i to completion (an unbounded
      // producer never EOFs) before stage i+1 ever spawns to send EPIPE.
      // Genuinely-compound stages (multi-statement / control-flow) keep the
      // in-process path (their builtin I/O contract is synchronous-string-based).
      const flattened = this.flattenSimpleStageNodes(stmt.stageNodes, stmt.pipeStderr ?? []);
      if (flattened) {
        let status = await this.execMultiStagePipeline(flattened, io);
        if (stmt.negate) status = status === 0 ? 1 : 0;
        return status;
      }
      let status = await this.execNodePipeline(stmt.stageNodes, stmt.pipeStderr ?? [], io);
      if (stmt.negate) status = status === 0 ? 1 : 0;
      return status;
    }

    const stages = stmt.stages ?? [];
    if (stages.length === 0) return 0;

    if (stmt.background) {
      return this.execBackground(stmt, io);
    }

    let status: number;
    if (stages.length === 1) {
      status = await this.execSimple(stages[0], io);
      this.pipeStatus = [status];
    } else {
      status = await this.execMultiStagePipeline(stages, io);
    }
    if (stmt.negate) status = status === 0 ? 1 : 0;
    return status;
  }

  /**
   * D5-fix: reduce a list of compound-stage pipeline nodes to a flat
   * `SimpleCommand[]` IFF every node is (or wraps) a single simple command AND
   * no inter-stage `|&` is present. Returns undefined otherwise — those
   * pipelines keep the serialized in-process path. A simple command carrying its
   * own input redirect on a non-first stage would change semantics, so we only
   * accept redirects on the first stage (where they become the stage's stdin).
   */
  private flattenSimpleStageNodes(nodes: Statement[], pipeStderr: boolean[]): SimpleCommand[] | undefined {
    if (pipeStderr.some(Boolean)) return undefined;
    const stages: SimpleCommand[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const cmd = this.extractSimpleCommand(nodes[i]);
      if (!cmd) return undefined;
      // Only the first stage may carry redirects (its stdin source); a later
      // stage's redirect would override the inter-stage pipe — keep those
      // in-process to preserve exact semantics.
      if (i > 0 && cmd.redirects.length > 0) return undefined;
      stages.push(cmd);
    }
    return stages;
  }

  /**
   * Run a pipeline whose stages are full command nodes (M1) in-process,
   * CONCURRENTLY, streaming byte-safe between stages. Adjacent stages are joined
   * by identity {@link TransformStream}s: stage i's stdout (and, for a `|&` join,
   * its stderr) writes into `transform[i].writable`; stage i+1 reads from
   * `transform[i].readable` as its stdin. All stages run under one `Promise.all`
   * so a downstream reader PULLS while the upstream pushes (an identity transform
   * has readable HWM 0 — a write only settles once someone reads), avoiding a
   * buffer-to-completion serialization AND a backpressure deadlock. A stage that
   * finishes producing closes its output writer (EOF downstream); a stage that
   * finishes consuming (possibly early, e.g. `head`) cancels its stdin so the
   * upstream's next write rejects — stopping an EXTERNAL producer (the kernel
   * tears its pipe down). An in-process BUILTIN infinite producer has no EPIPE
   * backstop and is not stopped by this (a pre-existing in-process limitation).
   *
   * The pipeline's status is the last stage's (or, under pipefail, the last
   * nonzero); a stage's own `exit N` is that stage's code only (subshell-like),
   * never the parent's. Compound stages (subshells/groups/if/…) run via
   * {@link execStatement}.
   */
  private async execNodePipeline(nodes: Statement[], pipeStderr: boolean[], io: CommandIO): Promise<number> {
    const n = nodes.length;
    // Inter-stage pipes: transform[i] connects stage i (stdout) → stage i+1 (stdin).
    const transforms = Array.from({ length: n - 1 }, () => new TransformStream<Uint8Array, Uint8Array>());
    const codes = new Array<number>(n).fill(0);
    // One sink per inter-stage pipe, created UP FRONT so a consumer stage can abort
    // its UPSTREAM producer's sink (transform[i-1]) when it finishes early — see the
    // finally block.
    const sinks = transforms.map((t) => sinkToStream(t.writable));

    const runStage = async (i: number): Promise<void> => {
      const isLast = i === n - 1;
      const outSink = isLast ? undefined : sinks[i];
      const stageStdout: OutputSink = isLast ? io.stdout : outSink!.sink;
      const stderrToNext = !isLast && pipeStderr[i];
      const stageIo = this.deriveIo(io, {
        stdout: stageStdout,
        stderr: stderrToNext ? stageStdout : io.stderr,
        // Stage 0 does not inherit the pipeline's live stdin here (a top-level
        // pipeline's stdin is the never-EOF root stream; a first-stage `read`
        // would block). A first stage's own `< file` is resolved per-command.
        stdin: i === 0 ? undefined : transforms[i - 1].readable,
      });
      try {
        const code = await this.execStatement(nodes[i], stageIo);
        // A stage's `exit N` is subshell-local: it is THAT stage's code (bash runs
        // each pipeline stage in a subshell — `{ exit 3; } | cat` is 0, decided by
        // the LAST stage). Capture it into this stage's code and CLEAR the shared
        // `this.exiting` immediately so it neither aborts the parent shell nor
        // contaminates a concurrent sibling stage (whose `execList` would otherwise
        // early-return on a non-undefined `this.exiting`).
        if (this.exiting !== undefined) { codes[i] = this.exiting; this.exiting = undefined; }
        else codes[i] = code;
      } catch (e) {
        // SIGPIPE-equivalent: the downstream stage closed early, so this stage's
        // next in-process write threw. Record 128+SIGPIPE(13)=141 as THIS stage's
        // code and stop cleanly — the downstream already ended, and the pipeline's
        // status is the LAST stage's (an in-process producer's 141 is internal,
        // mirroring bash's PIPESTATUS). Do NOT rethrow: the sibling downstream is
        // done and the parent shell must survive. Any OTHER error propagates.
        if (e instanceof BrokenPipeError) codes[i] = e.code;
        else throw e;
      } finally {
        // This stage finished (possibly early). Break its UPSTREAM producer first,
        // THEN EOF its own downstream:
        //  - Abort the upstream sink (transform[i-1]): a consumer that exits early
        //    (e.g. `head`, or a middle `cat` whose own downstream closed) leaves its
        //    stdin reader locked-but-abandoned, so the producer's next backpressured
        //    `writer.write()` would hang forever and strand its `close()`. Aborting
        //    rejects those writes → the producer's sink latches broken → its next
        //    write throws BrokenPipeError (in-process builtin) or its stdout pump
        //    stops (external). Also cancel the readable to release the reader lock.
        //  - close() this stage's own output sink (EOF to the next stage).
        if (i > 0) {
          sinks[i - 1].abort();
          await transforms[i - 1].readable.cancel().catch(() => {});
        }
        if (outSink) await outSink.close();
      }
    };

    await Promise.all(nodes.map((_, i) => runStage(i)));
    this.pipeStatus = codes;
    return this.pipelineStatus(codes, codes[codes.length - 1] ?? 0);
  }

  private async execMultiStagePipeline(stages: SimpleCommand[], io: CommandIO): Promise<number> {
    const expander = this.expander();
    // Expand only the NAME of each stage up front (the branch decision needs the
    // names). Each stage's `cmd.args` are expanded LATER — the all-builtin branch
    // expands them per-stage against that stage's own stdin so a `$(cat)` in
    // stage i reads stage i's piped input (bash); the external branch expands
    // them here (hoisted, ambient frame — unchanged). A command sub in a name or
    // arg still expands exactly once.
    const names: Array<{ name: string; extraArgv: string[]; env: Record<string, string> }> = [];
    for (const s of stages) names.push(await this.expandCommandName(s, expander));

    // Whether stage `i` runs as an in-process builtin/function. `cat` only
    // shadows the external when it has NO operands; decide that SYNTACTICALLY
    // (unexpanded arg words + extra name fields) so we needn't expand args before
    // the branch choice. Conservative: `cat $x` is treated as external even if
    // `$x` expands to nothing — the external `cat` reads fd-0 the same way, so
    // the result is unchanged.
    const stageIsBuiltin = (i: number): boolean => {
      const { name, extraArgv } = names[i];
      if (this.functions.has(name)) return true;
      if (!isBuiltin(name)) return false;
      if (name === 'cat') return stages[i].args.length === 0 && extraArgv.length === 0;
      return true;
    };

    if (names.every((_, i) => stageIsBuiltin(i))) {
      const enc = new TextEncoder();
      // Stage 0's fd-0 source, resolved once (later stages read the previous
      // stage's captured output):
      //   FIX 3 (item C): the FIRST stage's OWN `<`/`<<`/`<<<` redirect wins.
      //   FIX 4 (item H): with NO such redirect, INHERIT the enclosing frame's
      //     stdin (a nested pipeline inside a group whose stdin is an outer pipe
      //     or the group's own `< file`) — drained through the frame's shared
      //     reader into bytes. Guarded to a REAL inherited stream (not the shell's
      //     never-EOF root, not undefined) AND only when NO frame reader exists yet
      //     (a `while read …; do echo | cat; done < file` body must NOT eat the
      //     loop's SHARED cursor a sibling `read` owns — there stage 0 stays empty,
      //     bash: `echo` ignores stdin). Before both fixes stage 0 was hardcoded
      //     empty, so `cat < f | cat` produced nothing and a nested pipeline hung.
      let stage0Stdin = await this.resolveStdinStream(stages[0].redirects);
      if (stage0Stdin === undefined && io.stdin !== undefined && io.stdin !== this.rootStdinStream
        && !this.stdinReaderExists(io)) {
        const reader = this.stdinReaderFor(io);
        if (reader) stage0Stdin = bytesStream(await reader.readAll());
      }
      let stdin = '';
      let status = 0;
      const codes: number[] = [];
      const savedIo = this.io;
      try {
        for (let i = 0; i < stages.length; i++) {
          const isLast = i === stages.length - 1;
          const { name, extraArgv, env } = names[i];
          let captured = '';
          // Each builtin stage gets a derived frame: non-final stages capture into
          // the buffer feeding the next stage (byte-encoded into a one-shot stream);
          // the final stage writes to `io`. Stage 0 uses its resolved fd-0 (FIX 3/4).
          const stageStdin = i === 0 ? (stage0Stdin ?? bytesStream(enc.encode(stdin))) : bytesStream(enc.encode(stdin));
          const stageIo = this.deriveIo(io, { stdout: isLast ? io.stdout : (s) => { captured += s; }, stdin: stageStdin });
          // FIX 6 (item I): expand THIS stage's args against THIS stage's stdin so
          // a `$(cat)` in the args reads the stage's piped input (bash), not the
          // enclosing/root stdin. Set `this.io` to the stage frame across the arg
          // expansion (command subs read `this.io.stdin`), then restore.
          this.io = stageIo;
          const argv = [...extraArgv, ...await this.expandCommandArgs(stages[i], expander)];
          if (this.options.xtrace) savedIo.stderr('+ ' + [name, ...argv].join(' ') + '\n');
          status = await this.dispatch(name, argv, stageIo, { stdin: stageStdin });
          // A stage's `exit N` is subshell-local (bash runs each pipeline stage in a
          // subshell): it is THAT stage's code — the pipeline's status is the LAST
          // stage's (`{ exit 3; } | cat` → 0), and it does NOT abort the parent shell.
          // Capture + clear the shared `this.exiting` rather than returning early.
          if (this.exiting !== undefined) { status = this.exiting; this.exiting = undefined; }
          codes.push(status);
          stdin = captured;
        }
      } finally {
        this.io = savedIo;
      }
      this.pipeStatus = codes;
      return this.pipelineStatus(codes, status);
    }

    // Mixed/external pipeline: expand every stage's full command up front (as the
    // original hoisted pass did — kernel stages spawn concurrently, so there is no
    // sequential per-stage stdin to expand against). Preserves the prior ordering
    // (args expand BEFORE headFd0 drains stage 0's stdin).
    const expanded: Array<{ name: string; argv: string[]; env: Record<string, string> }> = [];
    for (let i = 0; i < stages.length; i++) {
      const { name, extraArgv, env } = names[i];
      const argv = [...extraArgv, ...await this.expandCommandArgs(stages[i], expander)];
      if (this.options.xtrace) io.stderr('+ ' + [name, ...argv].join(' ') + '\n');
      expanded.push({ name, argv, env });
    }

    // D8: a `<` / `<<` / `<<<` redirect on the FIRST stage becomes that stage's
    // fd-0 source (later stages read the previous stage's pipe). Without this a
    // stdin-reading head (`grep foo < file | sort`) would block. The kernel
    // pipe-feeds it — an `open` is streamed in-kernel, a `<<`/`<<<` body is
    // fed as bytes.
    //
    // FIX 4 (item H): the FIRST stage's OWN `<`/`<<`/`<<<` redirect wins; with NO
    // such redirect the first stage INHERITS the enclosing frame's stdin (a nested
    // pipeline inside a group whose stdin is an outer pipe or the group's own
    // `< file`) — drained into fd-0 bytes via resolveStdinFd's inherited-stdin
    // fallback. Guarded so the inherited-stdin drain fires ONLY when NO frame
    // reader exists yet: a `while read …; do echo | cat; done < file` body must NOT
    // eat the loop's SHARED cursor (a sibling `read` owns it) — there stage 0 stays
    // empty (bash: `echo` ignores stdin, the loop keeps its file cursor). The root
    // stream is never drained (checked inside resolveStdinFd). When a stage-0
    // redirect IS present, resolveStdinFd returns it before the fallback, so the
    // guard does not affect the redirect case.
    const stage0HasInputRedirect = stages[0].redirects.some(
      (r) => r.op === '<' || r.op === '<<' || r.op === '<<<' || r.op === '<>',
    );
    const inheritStage0Stdin = stage0HasInputRedirect || !this.stdinReaderExists(io);
    const headFd0 = await this.resolveStdinFd(stages[0].redirects, inheritStage0Stdin ? io : { ...io, stdin: undefined });

    const stageParams: PipelineStageParams[] = [];
    for (let i = 0; i < expanded.length; i++) {
      const { name, argv, env } = expanded[i];
      const isLast = i === expanded.length - 1;
      const code = this.resolve(name);
      if (code === undefined) { io.stderr(`shell: ${name}: command not found\n`); this.pipeStatus = [127]; return 127; }
      // Bug B: capture EVERY stage's stderr (each stage keeps its own), so an
      // early-stage error (e.g. `cat /nonexistent | sort`) reaches the terminal
      // rather than being discarded. Stdout is captured only on the last stage
      // (others feed the inter-stage pipe).
      stageParams.push({ code, args: [name, ...argv], env: { ...this.context.env, ...env }, cwd: this.context.cwd, captureStdout: isLast, captureStderr: true, fds: i === 0 && headFd0 ? { 0: headFd0 } : undefined });
    }

    if (this.kernel.runPipeline) {
      const result = await this.kernel.runPipeline(stageParams);
      if (result.lastStdout) await this.writeCaptured(result.lastStdout, io);
      // Surface each stage's stderr in stage order (after stdout is flushed).
      for (const s of result.stderr) await this.surfaceStderr(s, io);
      this.pipeStatus = result.exitCodes;
      return this.pipelineStatus(result.exitCodes, result.exitCodes[result.exitCodes.length - 1] ?? 0);
    }

    const handles = await Promise.all(stageParams.map((p) => this.kernel.spawn(toSpawnParams(p))));
    const last = handles[handles.length - 1];
    if (last?.stdout) await this.writeCaptured(last.stdout, io);
    const waits = await Promise.all(handles.map((h) => this.kernel.wait(h.pid)));
    // Surface each stage's stderr in stage order.
    for (const h of handles) await this.surfaceStderr(h.stderr, io);
    const codes = waits.map((w) => w.code);
    this.pipeStatus = codes;
    return this.pipelineStatus(codes, codes[codes.length - 1] ?? 0);
  }

  /**
   * A pipeline's exit status. Normally the LAST stage's code; under `set -o
   * pipefail` it is the LAST NON-ZERO stage's code (0 only if every stage
   * succeeded). `lastCode` is the pre-computed last-stage code.
   */
  private pipelineStatus(codes: number[], lastCode: number): number {
    if (!this.options.pipefail) return lastCode;
    for (let i = codes.length - 1; i >= 0; i--) {
      if (codes[i] !== 0) return codes[i];
    }
    return 0;
  }

  private async execSimple(cmd: SimpleCommand, io: CommandIO): Promise<number> {
    // DEBUG trap: bash runs it before EACH simple command. Suppress re-entry so a
    // trap action containing simple commands does not recurse indefinitely.
    if (!this.inDebugTrap && this.traps.has('DEBUG')) {
      this.inDebugTrap = true;
      try { await this.runTrap('DEBUG'); }
      finally { this.inDebugTrap = false; }
    }
    const expander = this.expander();
    const hasCommand = cmd.name !== '';

    // Scalar prefix assignments become a temporary overlay for a command. Build
    // it ONLY when there is a command to run it for — a bare assignment (no
    // command) is applied via applyAssignment below, so expanding its RHS here
    // too would evaluate it (and run any command substitution) an extra time.
    // Array / element / append forms only make sense as bare assignments.
    const localEnv: Record<string, string> = {};
    if (hasCommand) {
      for (const a of cmd.assignments) {
        if (a.array === undefined && a.index === undefined && !a.append) {
          localEnv[a.name] = await expander.expandToString(a.value);
        }
      }
    }

    const argExpander = hasCommand && Object.keys(localEnv).length > 0
      ? new Expander(this.environment.child(localEnv))
      : expander;

    // Expand the command NAME + ARGS only. The assignments are already handled
    // (localEnv overlay above for a command, or applyAssignment below for a bare
    // assignment), so skip expandCommand's own assignment expansion — re-expanding
    // here would double-run any command substitution in an assignment RHS.
    const { name, argv } = await this.expandCommand(cmd, argExpander, /*includeAssignmentEnv*/ false);

    // `$_` — bash sets it to the LAST argument of the command just parsed (or the
    // command name when there are no args). Update it before dispatch so a later
    // command in the same list sees the previous command's last word.
    if (name !== '') this.lastArgValue = argv.length > 0 ? argv[argv.length - 1] : name;

    if (name === '') {
      if (this.options.xtrace && cmd.assignments.length > 0) {
        io.stderr('+ ' + cmd.assignments.map((a) => `${a.name}=${a.value}`).join(' ') + '\n');
      }
      // A bare `x=$(cmd)` takes its status from the LAST command substitution in
      // the RHS (M10): `x=$(false); echo $?` → 1. With no command sub, status 0.
      // applyAssignment is the SOLE expansion of the RHS here (localEnv is not
      // built when hasCommand is false, and expandCommand no longer re-expands),
      // so any command substitution runs exactly once.
      // EDGE CASE: a PREFIX assignment whose command word expands to '' (e.g.
      // `x=$(cmd) $emptyvar` — a leading assignment plus a name that expands away).
      // There hasCommand is true so localEnv IS built (one expansion of the RHS),
      // yet expandCommand resolves the name to '' so we still land here and
      // applyAssignment runs (a second expansion). That rare form therefore stays
      // at 2× — acceptable; reordering to fix it would break the
      // prefix-overlay-affects-argv semantics. (`$emptyvar x=1`, by contrast, has
      // NO leading assignment — `x=1` is a plain argument — so it expands once.)
      this.lastCmdSubStatus = undefined;
      let rejected = false;
      for (const a of cmd.assignments) {
        if (await this.applyAssignment(a, expander)) rejected = true;
      }
      if (rejected) return 1; // a readonly reassignment (non-posix: status 1)
      const sub = this.lastCmdSubStatus;
      this.lastCmdSubStatus = undefined;
      return sub ?? 0;
    }

    // `exec` with redirects but NO command: install the redirects PERMANENTLY on
    // the per-shell fd table (H4). `exec 3>f`, `exec 3<f`, `exec 3<>f`,
    // `exec 3>&-` etc. With a command, `exec cmd` would replace the shell — we
    // treat it as a normal spawn (the sandbox has no execve).
    if (name === 'exec' && argv.length === 0) {
      return await this.execBuiltinRedirects(cmd.redirects, io);
    }

    if (this.options.xtrace) {
      io.stderr('+ ' + [name, ...argv].join(' ') + '\n');
    }

    // stdin: an explicit `<`/`<<`/`<<<` redirect wins; otherwise inherit a
    // compound-pipeline stage's piped stdin (M1). BUILTINS consume the stream via
    // the frame-scoped StdinReader (`read`/`cat`-builtin/`mapfile`); EXTERNALS get
    // a kernel fd-0 spec instead (D8): a `<` redirect opens the VFS path in-kernel
    // (streamed), a `<<`/`<<<` body or an inherited piped-stdin stream is fed as
    // fd-0 bytes — no inline copy for the file case.
    //
    // FIX 1 (item G): resolve the redirect ONCE into BOTH forms (stream + fdSpec)
    // so `<<< "$(cmd)"` runs its command substitution exactly once regardless of
    // whether the command is a builtin (uses `.stream`) or an external (`.fdSpec`).
    // A `< file` opening a missing file throws RedirectError here — catch it (like
    // the applyRedirects block below) so it reports + returns 1 and the statement
    // list CONTINUES, matching bash (an uncaught throw would abort the whole script).
    let resolvedInput: Awaited<ReturnType<Executor['resolveStdinInput']>>;
    try {
      resolvedInput = await this.resolveStdinInput(cmd.redirects);
    } catch (e) {
      if (e instanceof RedirectError) return this.onRedirectError(name, e, io);
      throw e;
    }
    const stdin = resolvedInput?.stream ?? io.stdin;

    // Apply output redirects to this command's frame. A refused redirect
    // (noclobber) aborts the command with status 1 — it never runs.
    let restore: (() => void) | undefined;
    if (cmd.redirects.length) {
      try {
        restore = await this.applyRedirects(cmd.redirects, io);
      } catch (e) {
        if (e instanceof RedirectError) return this.onRedirectError(name, e, io);
        throw e;
      }
    }
    // `command [-v|-p] CMD …` / `builtin CMD …` — run CMD bypassing any shell
    // FUNCTION of the same name (`command`) or forcing a builtin (`builtin`).
    // `command -v NAME` prints how NAME resolves (name/path) or exits 1 silently.
    if ((name === 'command' || name === 'builtin') && argv.length > 0) {
      let rest = argv;
      let dashV = false, dashBigV = false;
      if (name === 'command') {
        // Leading option flags, possibly CLUSTERED (`-vp`, `-Vp`); `--` ends options.
        while (rest.length > 0 && rest[0].length > 1 && rest[0][0] === '-' && rest[0] !== '--') {
          let bad = false;
          for (const ch of rest[0].slice(1)) {
            if (ch === 'v') dashV = true;
            else if (ch === 'V') dashBigV = true;
            else if (ch === 'p') { /* default-PATH search: accepted */ }
            else { bad = true; break; }
          }
          if (bad) break;
          rest = rest.slice(1);
        }
        if (rest[0] === '--') rest = rest.slice(1);
      }
      if (rest.length === 0) return 0;
      const target = rest[0];
      if (dashV || dashBigV) {
        // `command -v` prints how NAME resolves (name for keyword/function/builtin,
        // resolved $PATH path for an external) and exits 0; `-V` prints the verbose
        // "NAME is …" form. A genuine miss exits 1 (silently for -v).
        if (isShellKeyword(target)) { io.stdout(dashBigV ? `${target} is a shell keyword\n` : `${target}\n`); return 0; }
        if (this.functions.has(target)) { io.stdout(dashBigV ? `${target} is a function\n` : `${target}\n`); return 0; }
        if (isBuiltin(target)) { io.stdout(dashBigV ? `${target} is a shell builtin\n` : `${target}\n`); return 0; }
        const p = await this.resolveExternalPath(target);
        if (p !== undefined) { io.stdout(dashBigV ? `${target} is ${p}\n` : `${p}\n`); return 0; }
        if (dashBigV) io.stderr(`shell: command: ${target}: not found\n`);
        return 1;
      }
      if (name === 'builtin') {
        if (!isBuiltin(target)) { io.stderr(`shell: builtin: ${target}: not a shell builtin\n`); return 1; }
        return await this.dispatch(target, rest.slice(1), io, { stdin });
      }
      // `command CMD`: builtin-or-external, skipping functions.
      if (isBuiltin(target) && builtinShadowsExternal(target, rest.slice(1))) {
        return await this.dispatch(target, rest.slice(1), io, { stdin });
      }
      return await this.spawnExternal(target, rest.slice(1), localEnv, io, resolvedInput?.fdSpec);
    }
    try {
      if (this.functions.has(name)) {
        return await this.callFunction(name, argv, localEnv, io);
      }
      if (isBuiltin(name) && builtinShadowsExternal(name, argv)) {
        // A command-PREFIX assignment (`IFS=: read …`, `X=1 declare …`) is a
        // TRANSIENT overlay for the builtin's duration, then restored — for EVERY
        // builtin, including the env-mutating ones (bash: `X=1 export q=2` leaves X
        // unset). The builtin's OWN operands (`export q=2`, `declare foo=2`) write to
        // ctx.env directly and persist. A prefix key that is ALSO a builtin operand
        // (`X=1 export X=2`) must keep the operand's value — so we do NOT restore a
        // prefix key the builtin reassigned away from the overlay value.
        const overlayKeys = Object.keys(localEnv);
        const savedPrefix: Record<string, string | undefined> = {};
        if (overlayKeys.length > 0) {
          for (const k of overlayKeys) savedPrefix[k] = this.context.env[k];
        }
        Object.assign(this.context.env, localEnv);
        // Array-literal operands of an assignment builtin (`declare -a arr=(…)`)
        // are structured assignments the builtin applies via applyBuiltinAssignment.
        const arrayAssigns = cmd.assignments.filter((a) => a.array !== undefined);
        const status = await this.dispatch(name, argv, io,
          arrayAssigns.length > 0 ? { stdin, builtinAssignments: arrayAssigns, assignExpander: expander } : { stdin });
        if (overlayKeys.length > 0) {
          for (const k of overlayKeys) {
            // The builtin reassigned this key (operand won over the prefix) → keep it.
            if (this.context.env[k] !== localEnv[k]) continue;
            if (savedPrefix[k] === undefined) delete this.context.env[k];
            else this.context.env[k] = savedPrefix[k]!;
          }
        }
        return status;
      }
      // Resolve the external's fd-0. An explicit `<`/`<<`/`<<<` redirect wins →
      // the fd-0 spec already resolved ONCE above (FIX 1: no second expansion).
      // Otherwise, when this command INHERITS a live stdin stream (a compound-
      // pipeline stage's inter-stage pipe — NOT the never-EOF root stream) AND the
      // backend can live-stream (spawnStream) AND no sibling builtin has already
      // locked that stream (shared-cursor case), hand the STREAM straight to the
      // child's fd 0 so it flows chunk-by-chunk instead of being `readAll`-buffered
      // (which hangs at ~10k+ lines). Only one of the two is set: a redirect never
      // coexists with the inherited-stream path.
      if (resolvedInput) {
        return await this.spawnExternal(name, argv, localEnv, io, resolvedInput.fdSpec);
      }
      const inheritedLiveStdin =
        io.stdin !== undefined && io.stdin !== this.rootStdinStream ? io.stdin : undefined;
      if (inheritedLiveStdin && this.kernel.spawnStream && !this.stdinReaderExists(io)) {
        // The child consumes the stream via its fd 0 (spawnStream locks it with
        // `pumpStreamToPort`). Detach it from the frame so a LATER sibling command
        // does not try to read a now-locked/consumed stream — it correctly sees no
        // stdin (EOF), matching "the external already drained it".
        io.stdin = undefined;
        this.resetStdinReader(io);
        return await this.spawnExternal(name, argv, localEnv, io, undefined, inheritedLiveStdin);
      }
      const fd0 = await this.resolveStdinFd(cmd.redirects, io);
      return await this.spawnExternal(name, argv, localEnv, io, fd0);
    } finally {
      if (restore) restore();
      // Run any deferred `>(cmd)` substitutions now that the outer command has
      // written to their temp files (and the redirect sinks have flushed).
      await this.flushPendingProcSubs();
    }
  }

  /**
   * Apply an array-literal `name=(w…)` (or `name+=(w…)`) to the array/assoc store.
   * Each raw element word may carry an explicit `[subscript]=value` prefix (bash):
   *   - assoc target (declared `-A`): `[key]=value`; a bare word with no `[k]=` is
   *     an error in bash but we ignore it (matches "no key" — never reached via the
   *     structured path since `declare -A m=(a b)` still uses `[k]=` form in tests).
   *   - indexed target: `[idx]=value` sets that index and resets the running index
   *     to idx+1; a bare word takes the running index. A negative index counts from
   *     the current length. The value of a `[i]=v` element is NOT word-split; a bare
   *     word IS field-expanded (so `arr=($x)` splits). Integer arrays arith-evaluate.
   */
  private async applyArrayLiteral(name: string, words: string[], append: boolean, expander: Expander): Promise<boolean> {
    const intAttr = this.integerNames.has(name);
    const evalIfInt = (v: string): string => intAttr ? String(this.evalArithValue(v)) : v;
    const assoc = this.assocArrays.get(name);
    if (assoc !== undefined) {
      if (!append) assoc.clear();
      for (const w of words) {
        const m = /^\[(.*?)\]([+]?)=(.*)$/s.exec(w);
        if (m === null) continue; // assoc literal needs [key]=value pairs
        const key = await expander.substituteOnly(m[1]);
        const val = evalIfInt(await expander.expandToString(m[3]));
        assoc.set(key, m[2] === '+' ? (assoc.get(key) ?? '') + val : val);
      }
      delete this.context.env[name];
      return false;
    }
    const arr = append ? (this.arrays.get(name) ?? []) : [];
    let next = arr.length; // running index (append continues past existing length)
    for (const w of words) {
      const m = /^\[(.*?)\]([+]?)=(.*)$/s.exec(w);
      if (m !== null) {
        const sub = (await expander.substituteOnly(m[1])).trim();
        let idx = /^-?\d+$/.test(sub) ? parseInt(sub, 10)
          : (() => { try { return Number(evalArith(sub, this.arithEnvForExpr(), this.arithArrayAccessExec())); } catch { return 0; } })();
        if (idx < 0) idx = arr.length + idx;
        const val = evalIfInt(await expander.expandToString(m[3]));
        arr[idx] = m[2] === '+' ? (arr[idx] ?? '') + val : val;
        next = idx + 1;
      } else {
        // Bare word: field-expand (may split into several elements at the running index).
        for (const f of await expander.expandWord(w)) arr[next++] = evalIfInt(f);
      }
    }
    this.arrays.set(name, arr);
    delete this.context.env[name];
    return false;
  }

  /**
   * Apply a (bare) assignment to persistent shell state, handling all forms:
   *   - `name=v` / `name+=v`            scalar (append concatenates)
   *   - `name=(w…)` / `name+=(w…)`      indexed array literal (append extends)
   *   - `name[i]=v` / `name[i]+=v`      element assignment (append concatenates)
   * Array element words are field-expanded (so `arr=($x)` splits), scalar values
   * are expanded to a single string.
   */
  private async applyAssignment(a: { name: string; value: string; array?: string[]; index?: string; append?: boolean }, expander: Expander): Promise<boolean> {
    // `declare -n ref=target`: a write to `ref` is redirected to `target`
    // (single-level). Rewrite the assignment name BEFORE the readonly check so a
    // write THROUGH a nameref to a readonly target is also rejected.
    const nameref = this.namerefs.get(a.name);
    if (nameref !== undefined) a = { ...a, name: nameref };
    // A reassignment of a `readonly` name (checked on the resolved target) is
    // rejected (the old value is kept). In a non-interactive POSIX-mode shell this
    // is a fatal assignment error (POSIX 2.8.1): throw PosixSpecialBuiltinError so
    // the statement-loop aborts. The message must NOT carry its own `shell: `
    // prefix — that catch prepends one. Otherwise report to stderr and return
    // `true` (rejected) so the caller surfaces a nonzero status without writing.
    if (this.readonlyNames.has(a.name)) {
      const msg = `${a.name}: readonly variable`;
      if (this.options.posix) throw new PosixSpecialBuiltinError(a.name, 1, msg);
      this.io.stderr(`shell: ${msg}\n`);
      this.lastStatus = 1;
      return true;
    }
    // NOTE: a bare `name=value` / `name=(…)` assignment (even inside a function) is
    // GLOBAL in bash — it modifies the existing variable in the nearest enclosing
    // scope, defaulting to global. It is NOT auto-localized. Function-local scoping
    // happens ONLY via the `local`/`declare`/`typeset` builtins (which call
    // declareLocal to snapshot for restore). So applyAssignment must NOT declareLocal.
    if (a.array !== undefined) {
      return await this.applyArrayLiteral(a.name, a.array, a.append ?? false, expander);
    }
    if (a.index !== undefined) {
      // An integer-attributed array (`declare -i a`) arithmetic-evaluates element
      // RHS values; `+=` adds numerically. Otherwise the value is a plain string.
      const intAttr = this.integerNames.has(a.name);
      const evalIfInt = (raw: string, prev: string): string => {
        if (!intAttr) return a.append ? prev + raw : raw;
        const rhs = this.evalArithValue(raw);
        return String(a.append ? this.evalArithValue(prev || '0') + rhs : rhs);
      };
      // Associative array element (`name[key]=v`, name declared via `declare -A`):
      // the subscript is a STRING key, not a numeric index (G6).
      const assoc = this.assocArrays.get(a.name);
      if (assoc !== undefined) {
        const key = await expander.substituteOnly(a.index);
        const val = await expander.expandToString(a.value);
        assoc.set(key, evalIfInt(val, assoc.get(key) ?? ''));
        return false;
      }
      // The subscript is arithmetic (bash): `a[i]=`, `a[i+1]=`, `a[b[0]]=` all work.
      const sub = await expander.substituteOnly(a.index);
      let idx = /^-?\d+$/.test(sub.trim()) ? parseInt(sub.trim(), 10)
        : (() => { try { return Number(evalArith(sub, this.arithEnvForExpr(), this.arithArrayAccessExec())); } catch { return 0; } })();
      const arr = this.arrays.get(a.name) ?? (this.context.env[a.name] !== undefined ? [this.context.env[a.name]] : []);
      if (idx < 0) idx = arr.length + idx; // negative index counts from the end
      const val = await expander.expandToString(a.value);
      arr[idx] = evalIfInt(val, arr[idx] ?? '');
      this.arrays.set(a.name, arr);
      delete this.context.env[a.name];
      return false;
    }
    // Scalar (possibly append). If the name currently holds an array, `name+=v`
    // appends to element 0 in bash; we keep it simple and treat scalars only.
    const val = await expander.expandToString(a.value);
    // RANDOM / SHLVL / BASH_VERSION[INFO] have special set() semantics (seed /
    // recompute / read-only) — route through set() rather than writing env
    // directly so `RANDOM=42` seeds the generator (G7).
    if (a.name === 'RANDOM' || a.name === 'SHLVL'
      || a.name === 'BASH_VERSION' || a.name === 'BASH_VERSINFO') {
      // RANDOM / SHLVL / BASH_VERSION[INFO] have special set() semantics (seed /
      // recompute / read-only) — route through Environment.set so `RANDOM=42`
      // seeds the generator (G7).
      this.environment.set(a.name, a.append ? (this.context.env[a.name] ?? '') + val : val);
      return false;
    }
    // An integer-attributed name (`declare -i`) evaluates its RHS arithmetically;
    // `+=` adds numerically rather than string-concatenating (bash).
    if (this.integerNames.has(a.name)) {
      const rhs = this.evalArithValue(val);
      const next = a.append ? this.evalArithValue(this.context.env[a.name] ?? '0') + rhs : rhs;
      this.context.env[a.name] = String(next);
      return false;
    }
    this.context.env[a.name] = a.append ? (this.context.env[a.name] ?? '') + val : val;
    return false;
  }

  /** Arithmetic-evaluate a string to a 64-bit bigint for an integer-attributed assignment (0 on error). */
  private evalArithValue(expr: string): bigint {
    try { return evalArith(expr, this.arithEnvForExpr(), this.arithArrayAccessExec()); }
    catch { return 0n; }
  }

  private async spawnExternal(name: string, argv: string[], localEnv: Record<string, string>, io: CommandIO, fd0?: StdinFdSpec, stdinStream?: ReadableStream<Uint8Array>): Promise<number> {
    const code = this.resolve(name);
    if (code === undefined) {
      io.stderr(`shell: ${name}: command not found\n`);
      return 127;
    }
    const params: SpawnParams = {
      code, args: [name, ...argv],
      env: { ...this.context.env, ...localEnv },
      cwd: this.context.cwd,
      captureStdout: true,
      // Bug B: capture the child's stderr so its diagnostics reach the shell's
      // stderr sink instead of being silently discarded (the bug that hid every
      // external command's errors — e.g. `cat /nonexistent`).
      captureStderr: true,
      // D8: pipe-fed stdin. fds[0] open (a `< file`, streamed in-kernel) or bytes
      // (a `<<`/`<<<` body or inherited piped-stdin string). Absent ⇒ the kernel
      // delivers an immediate EOF so a stdin-reading child does not block.
      fds: fd0 ? { 0: fd0 } : undefined,
      // Streamed fd-0: a compound-pipeline stage's INHERITED live stdin, handed to
      // `spawnStream` so it flows chunk-by-chunk into the child (no readAll hang).
      // Mutually exclusive with `fd0` (the call site sets at most one).
      stdinStream,
    };
    // A1: prefer the live-stream spawn path — the child's stdout arrives as a
    // ReadableStream we pump chunk-by-chunk into our stdout sink, so a large or
    // unbounded producer streams rather than being buffered to completion (which
    // defeats the kernel's credit-windowed back-pressure). Falls back to the
    // buffered spawn on backends that don't transfer ports. In BOTH branches the
    // child's stderr is BUFFERED (the live path streams only stdout) and surfaced
    // to `io.stderr` after the child exits.
    if (this.kernel.spawnStream) {
      const handle = await this.kernel.spawnStream(params);
      if (handle.stdout) await this.pumpToStdout(handle.stdout, io);
      const { code: status } = await this.kernel.wait(handle.pid);
      await this.surfaceStderr(handle.stderr, io);
      return status;
    }
    const handle = await this.kernel.spawn(params);
    if (handle.stdout) await this.writeCaptured(handle.stdout, io);
    const { code: status } = await this.kernel.wait(handle.pid);
    await this.surfaceStderr(handle.stderr, io);
    return status;
  }

  /**
   * Bug B: drain a child's captured stderr (a `Promise<Uint8Array>`) into the
   * command's stderr sink (the EXPLICIT frame, captured by the caller — D3), so
   * an external command's diagnostics reach the terminal. A `undefined` promise
   * (a backend that does not capture stderr) is a no-op.
   */
  private async surfaceStderr(bytes: Promise<Uint8Array> | undefined, io: CommandIO): Promise<void> {
    if (!bytes) return;
    let out: Uint8Array;
    try { out = await bytes; } catch { return; }
    if (out.byteLength > 0) io.stderr.writeBytes(out);
  }

  /**
   * A1: drain a live child-stdout ReadableStream into the command's stdout sink
   * (the EXPLICIT frame `io`, captured here so a post-await chunk lands in this
   * command's sink — not whatever the foreground swapped the ambient frame to,
   * D3), forwarding each chunk's raw bytes via `writeBytes` (no UTF-8 decode), so
   * binary output is byte-exact and multi-byte chars spanning a chunk boundary are
   * never mangled. Cancels the stream if the sink throws (a broken downstream),
   * propagating EPIPE up to the child via portToReadable.
   */
  private async pumpToStdout(stream: ReadableStream<Uint8Array>, io: CommandIO): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) io.stdout.writeBytes(value);
      }
    } catch {
      // Downstream broke or stream errored — stop reading; the cancel below (via
      // releaseLock + GC) and the kernel EOF wiring tear the child's pipe down.
      try { await reader.cancel(); } catch { /* already closed */ }
    } finally {
      reader.releaseLock();
    }
  }

  private async callFunction(name: string, argv: string[], localEnv: Record<string, string>, io: CommandIO): Promise<number> {
    const fn = this.functions.get(name)!;
    const savedPositional = this.context.positional;
    this.context.positional = argv;
    this.localScopes.push(new Set());
    this.localSaved.push(new Map());
    this.localSavedArrays.push(new Map());
    this.funcStack.unshift(name);
    const overlayKeys = Object.keys(localEnv);
    const savedOverlay: Record<string, string | undefined> = {};
    for (const k of overlayKeys) { savedOverlay[k] = this.context.env[k]; this.context.env[k] = localEnv[k]; }
    let status = 0;
    try {
      status = await this.execList(fn.body, io);
    } catch (e) {
      if (e instanceof FuncReturn) status = e.code;
      else throw e;
    } finally {
      // RETURN trap: bash fires it when a function (or sourced script) returns,
      // BEFORE control returns to the caller and while the function name is still
      // on the stack. Suppress re-entry via inDebugTrap-style guard is unneeded —
      // a RETURN inside the handler would need its own function frame.
      if (this.traps.has('RETURN')) await this.runTrap('RETURN');
      this.funcStack.shift();
      // restore locals
      const scope = this.localScopes.pop()!;
      const saved = this.localSaved.pop()!;
      const savedArr = this.localSavedArrays.pop()!;
      for (const k of scope) {
        const v = saved.get(k);
        if (v === undefined) delete this.context.env[k];
        else this.context.env[k] = v;
        // Restore array/assoc storage + integer/readonly/nameref attributes to the
        // pre-local snapshot (a function-local `-r`/`-n`/`-i`/array must not leak).
        const sa = savedArr.get(k);
        if (sa === undefined || sa.arr === undefined) this.arrays.delete(k);
        else this.arrays.set(k, sa.arr);
        if (sa === undefined || sa.assoc === undefined) this.assocArrays.delete(k);
        else this.assocArrays.set(k, sa.assoc);
        if (sa === undefined || !sa.integer) this.integerNames.delete(k);
        else this.integerNames.add(k);
        if (sa === undefined || !sa.readonly) this.readonlyNames.delete(k);
        else this.readonlyNames.add(k);
        if (sa === undefined || sa.nameref === undefined) this.namerefs.delete(k);
        else this.namerefs.set(k, sa.nameref);
      }
      for (const k of overlayKeys) {
        if (savedOverlay[k] === undefined) delete this.context.env[k];
        else this.context.env[k] = savedOverlay[k]!;
      }
      this.context.positional = savedPositional;
    }
    return status;
  }

  /** Function-call name stack, most-recent first — backs `$FUNCNAME`. */
  funcNameStack(): readonly string[] { return this.funcStack; }

  /**
   * `declare -p [names]` reconstruction. Builds a `declare …` line per variable
   * with its attribute flags (`-r`/`-i`/`-a`/`-A`) and a re-inputtable value. With
   * no names, lists every set scalar + array + assoc (sorted).
   */
  private declareP(names: string[]): { lines: string[]; missing: string[] } {
    // A value is double-quoted normally, or the ANSI-C `$'…'` form for control chars
    // (bash: `declare -a a=([0]=$'x\ty')`).
    const CTRL = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex
    const val = (s: string): string => CTRL.test(s) ? shellQuoteQ(s) : '"' + s.replace(/[\\"$`]/g, (c) => '\\' + c) + '"';
    // Assoc keys stay BARE when safe, double-quoted otherwise (bash: `[one]`, `["a b"]`).
    const KEY_SAFE = /^[A-Za-z0-9_./:=@%+,-]+$/;
    const key = (k: string): string => KEY_SAFE.test(k) ? k : '"' + k.replace(/[\\"$`]/g, (c) => '\\' + c) + '"';
    const flagFor = (n: string): string => {
      let f = '';
      if (this.assocArrays.has(n)) f += 'A';
      else if (this.arrays.has(n)) f += 'a';
      if (this.integerNames.has(n)) f += 'i';
      if (this.readonlyNames.has(n)) f += 'r';
      return f;
    };
    const line = (n: string): string | undefined => {
      const flags = flagFor(n);
      const opt = flags === '' ? '--' : '-' + flags;
      if (this.assocArrays.has(n)) {
        // Assoc arrays get a TRAILING space after the last pair (bash); indexed don't.
        const m = this.assocArrays.get(n)!;
        const body = [...m.entries()].map(([k, v]) => `[${key(k)}]=${val(v)}`).join(' ');
        return `declare ${opt} ${n}=(${body}${body === '' ? '' : ' '})`;
      }
      if (this.arrays.has(n)) {
        const arr = this.arrays.get(n)!;
        const body = arr.map((v, i) => i in arr ? `[${i}]=${val(v)}` : undefined).filter((x) => x !== undefined).join(' ');
        return `declare ${opt} ${n}=(${body})`;
      }
      if (n in this.context.env) return `declare ${opt} ${n}=${val(this.context.env[n])}`;
      if (this.readonlyNames.has(n) || this.integerNames.has(n)) return `declare ${opt} ${n}`;
      return undefined;
    };
    if (names.length === 0) {
      const all = new Set<string>([...Object.keys(this.context.env), ...this.arrays.keys(), ...this.assocArrays.keys()]);
      const lines: string[] = [];
      for (const n of [...all].sort()) { const l = line(n); if (l !== undefined) lines.push(l); }
      return { lines, missing: [] };
    }
    const lines: string[] = [];
    const missing: string[] = [];
    for (const n of names) { const l = line(n); if (l !== undefined) lines.push(l); else missing.push(n); }
    return { lines, missing };
  }

  // ── background / jobs ─────────────────────────────────────────────────────────

  private async execBackground(stmt: Statement, io: CommandIO): Promise<number> {
    const job = this.jobControl.register(describeStages(stmt.stages ?? []));

    // D3: the background job gets its OWN forked I/O frame, captured NOW. Its
    // sinks + fd-table are independent of the foreground's `io`, so a redirect /
    // command-sub the FOREGROUND installs after this job parks (mutating its own
    // frame) can never re-route this job's bytes — and the bg job's own redirects
    // (which mutate `bgIo`'s fd-table snapshot) do not leak into the parent.
    const bgIo = this.deriveIo(io, {}, /*fork*/ true);

    // D4: a single EXTERNAL command backgrounded gets a REAL kernel pid via the
    // direct-spawn path (spawnStream) — so `$!` is the real leader and `kill %1`
    // / `kill <pid>` reach the live child via kernel.kill. We pump its stdout to
    // the bg frame's stdout in the background (not awaited) and resolve the job
    // from kernel.wait(realPid). Builtins / functions / compound bodies have no
    // kernel child, so they keep a synthetic pid and run detached in-process.
    // Only EXPAND the command for the direct-spawn path when that path is
    // available: `backgroundExternal` expands the command (incl. a prefix
    // assignment's `$(…)` RHS), and the in-process fallback below re-expands via
    // `execStatement`→`execSimple`. Calling it unconditionally would run a
    // side-effecting RHS (`x=$(cmd) realcmd &`) TWICE on a no-`spawnStream`
    // backend. Gate on `spawnStream` so the RHS is expanded exactly once.
    const external = this.kernel.spawnStream ? await this.backgroundExternal(stmt) : undefined;
    if (external && this.kernel.spawnStream) {
      try {
        const handle = await this.kernel.spawnStream(external);
        job.pids = [handle.pid];
        this.jobControl.setLastBgPid(handle.pid);
        // Stream the child's stdout to the bg frame's stdout in the background
        // (fire-and-forget). The job's COMPLETION is the child's exit — awaited
        // directly via kernel.wait — NOT the pump finishing: a killed child may
        // never EOF its stdout pipe, so chaining wait AFTER the pump would hang
        // `wait`. The captured `bgIo.stdout` is the original sink, immune to the
        // foreground's later redirects (D3).
        const reader = handle.stdout?.getReader();
        if (reader) void this.pumpReaderToSink(reader, bgIo.stdout);
        job.promise = this.kernel.wait(handle.pid)
          .then((w) => { job.state = 'done'; job.exitCode = w.code; if (reader) void reader.cancel().catch(() => {}); return w.code; })
          .catch(() => { job.state = 'done'; job.exitCode = 1; if (reader) void reader.cancel().catch(() => {}); return 1; });
        return 0;
      } catch {
        // Fall through to the in-process detached path on spawn failure.
      }
    }

    // In-process / synthetic-pid path (builtins, functions, compound bodies, or
    // backends without spawnStream). The synthetic pid models a job leader that
    // has no kernel-side process to signal. The detached statement runs against
    // `bgIo` — its own frame — so an interleaving foreground command's redirect
    // / capture can never re-route this job's output (the D3 race).
    const pid = 100000 + job.id;
    job.pids = [pid];
    this.jobControl.setLastBgPid(pid);
    const bg = { ...stmt, background: false };
    job.promise = this.execStatement(bg, bgIo).then((code) => {
      job.state = 'done';
      job.exitCode = code;
      return code;
    }).catch(() => { job.state = 'done'; job.exitCode = 1; return 1; });
    return 0;
  }

  /**
   * D4: if `stmt` is a single EXTERNAL command (one-stage pipeline, not a builtin
   * that shadows / not a function), expand it and return SpawnParams ready for a
   * direct kernel spawn. Returns undefined for anything that must run in-process
   * (builtins, functions, pipelines, compounds).
   */
  private async backgroundExternal(stmt: Statement): Promise<SpawnParams | undefined> {
    if (stmt.type !== 'Pipeline' || !stmt.stages || stmt.stages.length !== 1) return undefined;
    const cmd = stmt.stages[0];
    if (cmd.redirects.length > 0) return undefined; // redirects: keep the in-process path
    const expander = this.expander();
    const { name, argv, env } = await this.expandCommand(cmd, expander);
    if (name === '') return undefined;
    if (this.functions.has(name)) return undefined;
    if (isBuiltin(name) && builtinShadowsExternal(name, argv)) return undefined;
    const code = this.resolve(name);
    if (code === undefined) return undefined;
    return { code, args: [name, ...argv], env: { ...this.context.env, ...env }, cwd: this.context.cwd };
  }

  /** D4: pump a live child-stdout reader into a captured sink (background jobs). */
  private async pumpReaderToSink(reader: ReadableStreamDefaultReader<Uint8Array>, sink: OutputSink): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) sink.writeBytes(value);
      }
    } catch {
      // Cancelled (job ended / stream errored) — stop pumping.
    }
  }

  /**
   * A2: `coproc [NAME] command`. Start `command` as a BACKGROUND child wired to
   * a bidirectional pipe pair (minted via the kernel). Expose the shell-retained
   * ends as two numbered fds — `${NAME[0]}` (read child stdout) and `${NAME[1]}`
   * (write child stdin) — plus `NAME_PID` (the real child pid). `read -u
   * ${NAME[0]}` and `echo >&${NAME[1]}` then work via the existing fd machinery.
   *
   * Requires a transferable backend (the pipe pair is transferred MessagePorts).
   * On a non-transferable backend `spawnCoproc` rejects ENOSYS and we emit the
   * precise `coproc: requires a transferable backend` diagnostic.
   */
  private async execCoproc(stmt: Statement, io: CommandIO): Promise<number> {
    if (!this.kernel.spawnCoproc) {
      io.stderr('shell: coproc: requires a transferable backend\n');
      return 1;
    }
    const simple = this.extractSimpleCommand(stmt.coprocBody);
    if (!simple) {
      io.stderr('shell: coproc: only a single external command is supported\n');
      return 1;
    }
    const expander = this.expander();
    const { name, argv, env } = await this.expandCommand(simple, expander);
    const code = this.resolve(name);
    if (code === undefined) {
      io.stderr(`shell: ${name}: command not found\n`);
      return 127;
    }
    let handle;
    try {
      handle = await this.kernel.spawnCoproc({
        code, args: [name, ...argv],
        env: { ...this.context.env, ...env },
        cwd: this.context.cwd,
      });
    } catch (e) {
      const c = (e as { code?: string }).code;
      if (c === 'ENOSYS') { io.stderr('shell: coproc: requires a transferable backend\n'); return 1; }
      throw e;
    }

    // Allocate two shell fds for the retained ends. Read fd serves `read -u`,
    // write fd serves `echo >&N` (its sink writes to the child's stdin). These
    // fds persist for later commands, so they go on the (foreground) frame's
    // table, which is the persistent fd table.
    const readFd = this.allocCoprocFd();
    const writeFd = this.allocCoprocFd();
    io.fdTable.set(readFd, {
      mode: 'read',
      duplex: { readLine: () => handle.readLine(), write: () => { /* read end: no write */ }, close: () => handle.close() },
    });
    io.fdTable.set(writeFd, {
      mode: 'write',
      sink: toSink((s: string) => { void Promise.resolve(handle.write(s)); }),
      close: () => handle.close(),
    });

    // Expose ${NAME[0]} / ${NAME[1]} and NAME_PID. The array holds the fd
    // NUMBERS (as bash does); NAME_PID is the real child pid.
    const arrName = stmt.coprocName ?? 'COPROC';
    this.arrays.set(arrName, [String(readFd), String(writeFd)]);
    delete this.context.env[arrName];
    this.context.env[`${arrName}_PID`] = String(handle.pid);
    this.jobControl.setLastBgPid(handle.pid);

    // Register a background job so `wait`/`jobs` see the coproc child.
    const job = this.jobControl.register(`coproc ${arrName}`, [handle.pid]);
    job.promise = this.kernel.wait(handle.pid).then((w) => {
      job.state = 'done'; job.exitCode = w.code; return w.code;
    }).catch(() => { job.state = 'done'; job.exitCode = 1; return 1; });
    return 0;
  }

  /** Coproc retained-end fds start at 63 and descend (bash uses high fds). */
  private nextCoprocFd = 63;
  private allocCoprocFd(): number {
    while (this.fdTable.has(this.nextCoprocFd) && this.nextCoprocFd > 10) this.nextCoprocFd--;
    return this.nextCoprocFd--;
  }

  /**
   * Extract the single simple command from a coproc body: a one-stage pipeline,
   * or a Group/Subshell wrapping exactly one such statement. Returns undefined
   * for genuinely-compound bodies (multiple statements / control flow), which
   * the coproc path does not spawn as an external.
   */
  private extractSimpleCommand(body: Statement | undefined): SimpleCommand | undefined {
    if (!body) return undefined;
    if (body.type === 'Pipeline' && body.stages?.length === 1) return body.stages[0];
    if ((body.type === 'Group' || body.type === 'Subshell') && body.body?.length === 1) {
      return this.extractSimpleCommand(body.body[0]);
    }
    return undefined;
  }

  // ── dispatch helpers ──────────────────────────────────────────────────────────

  private async expandCommand(cmd: SimpleCommand, expander: Expander, includeAssignmentEnv = true): Promise<{ name: string; argv: string[]; env: Record<string, string> }> {
    const env: Record<string, string> = {};
    // Only scalar prefix assignments form the command-prefix env overlay; array /
    // element / append forms are handled as bare assignments by the executor.
    // `execSimple` passes includeAssignmentEnv=false because it builds its own
    // overlay (a command) or applies via applyAssignment (a bare assignment), so
    // re-expanding the RHS here would double-run any command substitution.
    if (includeAssignmentEnv) {
      for (const a of cmd.assignments) {
        if (a.array === undefined && a.index === undefined && !a.append) {
          env[a.name] = await expander.expandToString(a.value);
        }
      }
    }
    const nameFields = cmd.name === '' ? [] : await expander.expandWord(cmd.name);
    const name = nameFields[0] ?? '';
    const argv: string[] = [...nameFields.slice(1)];
    for (const arg of cmd.args) argv.push(...await expander.expandWord(arg));
    return { name, argv, env };
  }

  /**
   * Expand ONLY the command NAME word (not `cmd.args`), returning the resolved
   * name plus any EXTRA fields the name word split into (e.g. `$cmd` → `foo bar`
   * contributes `bar` to argv). Used by `execMultiStagePipeline` so the branch
   * decision has the names while each stage's `cmd.args` are expanded LATER —
   * per-stage, against that stage's own stdin — so a `$(cat)` in stage i reads
   * stage i's piped input (bash). Each command substitution still expands once.
   */
  private async expandCommandName(cmd: SimpleCommand, expander: Expander): Promise<{ name: string; extraArgv: string[]; env: Record<string, string> }> {
    const env: Record<string, string> = {};
    for (const a of cmd.assignments) {
      if (a.array === undefined && a.index === undefined && !a.append) {
        env[a.name] = await expander.expandToString(a.value);
      }
    }
    const nameFields = cmd.name === '' ? [] : await expander.expandWord(cmd.name);
    return { name: nameFields[0] ?? '', extraArgv: nameFields.slice(1), env };
  }

  /** Expand a command's ARGS (only `cmd.args`), against the current ambient frame. */
  private async expandCommandArgs(cmd: SimpleCommand, expander: Expander): Promise<string[]> {
    const argv: string[] = [];
    for (const arg of cmd.args) argv.push(...await expander.expandWord(arg));
    return argv;
  }

  /**
   * Dispatch a builtin (with loop/return control surfaced as exceptions) against
   * the command's I/O `frame`. The builtin's `write`/`writeErr`/`readFdLine`
   * route through `frame` so a redirect / pipeline-stage capture / background
   * job's sinks are honored without touching shared instance fields. `opts.write`
   * (a pipeline capture sink) overrides the frame's stdout. `opts.stdin` (a
   * per-command `<`/`<<`/`<<<` redirect or an inherited pipeline stage's piped
   * stdin) installs a stdin override on a DERIVED frame. Stdin reads bind to that
   * frame's shared {@link StdinReader} (one cursor), so `read`/`cat`/`mapfile`
   * consume incrementally. The ambient `this.io` is set to `frame` so a builtin's
   * `eval` / `source` runs against it too.
   */
  private async dispatch(name: string, argv: string[], frame: CommandIO, opts: { stdin?: ReadableStream<Uint8Array>; write?: (s: string) => void; builtinAssignments?: Assignment[]; assignExpander?: Expander } = {}): Promise<number> {
    this.io = frame;
    // A GENUINE per-command stdin override is an `opts.stdin` that DIFFERS from
    // the inherited frame stdin — a `<`/`<<`/`<<<` redirect stream or a pipeline
    // stage's captured stream. `opts.stdin === frame.stdin` (the common case, incl.
    // `read <&3` which passes the inherited io.stdin) is NOT an override.
    const hasStdinOverride = opts.stdin !== undefined && opts.stdin !== frame.stdin;
    if (hasStdinOverride) frame = this.deriveIo(frame, { stdin: opts.stdin });
    const readerFor = (): StdinReader | undefined => this.stdinReaderFor(frame);
    const ctx: BuiltinContext = {
      cwd: this.context.cwd,
      env: this.context.env,
      write: opts.write ?? ((s) => frame.stdout(s)),
      writeErr: (s) => frame.stderr(s),
      writeBytes: (b) => frame.stdout.writeBytes(b),
      stdin: frame.stdin,
      lastStatus: this.lastStatus,
      exit: (code) => { this.exiting = code; },
      eval: (src) => this.run(this.parseSrc(src), true),
      sourceFile: (args) => this.sourceFile(args),
      readFdLine: (fd) => this.readFdLine(fd, frame),
      consumeFdLine: (fd) => this.consumeFdLine(fd, frame),
      // `read <&N` aliased fd 0 to fd N (applyRedirects). If fd 0 now carries a
      // live duplex or buffered input, `read` (no `-u`) must source from it via
      // readFdLine(0) rather than the plain-stdin frame reader.
      // `read <&N` aliased fd 0 to fd N (applyRedirects, which recorded fd 0 in
      // `#stdinDupFds` for THIS command). `read` (no `-u`) then sources from fd 0
      // via readFdLine(0). GUARD precisely: fire ONLY when THIS command's own `<&0`
      // alias installed the fd-0 entry — NOT for a lingering entry from an ambient
      // `exec 0<file`/`exec 0<>…` (else `exec 0<f; printf x | { read y; }` would
      // wrongly read the file instead of the pipe). A genuine stdin override
      // (pipeline stage / `<` / `<<<`) also wins over any fd-0 entry.
      stdinFd: (!hasStdinOverride && this.stdinDupFds.has(0)
        && (() => { const e = frame.fdTable.get(0); return !!(e && (e.duplex || e.input !== undefined)); })())
        ? 0 : undefined,
      readStdinLine: (timeoutSec) => this.readStdinLine(frame, timeoutSec),
      readStdinAll: () => { const r = readerFor(); return r ? r.readAll() : Promise.resolve(new Uint8Array()); },
      readStdinPump: (sink) => { const r = readerFor(); return r ? r.pumpTo(sink) : Promise.resolve(); },
      readStdinChunk: (delim, max, ignoreDelim) => {
        const r = readerFor();
        if (!r) return Promise.resolve(undefined);
        if (ignoreDelim) return r.readBytes(max ?? Number.MAX_SAFE_INTEGER).then((s) => (s === '' ? undefined : s));
        return r.readUntil(delim ?? '\n', max);
      },
      doBreak: (n) => { throw new LoopBreak(n); },
      doContinue: (n) => { throw new LoopContinue(n); },
      doReturn: (n) => { throw new FuncReturn(n); },
      evalArith: (expr) => evalArith(expr, this.arithEnvForExpr(), this.arithArrayAccessExec()),
      resolveExternal: (n) => this.resolveExternalPath(n),
      builtinAssignments: opts.builtinAssignments,
      applyBuiltinAssignment: opts.assignExpander
        ? (a) => this.applyAssignment(a, opts.assignExpander!)
        : undefined,
      state: this.shellState(),
    };
    const status = await runBuiltin(name, argv, ctx);
    this.context.cwd = ctx.cwd;
    return status;
  }

  private async writeCaptured(bytes: Promise<Uint8Array>, io: CommandIO): Promise<void> {
    const out = await bytes;
    // Post-await: write through the EXPLICIT (captured) frame, not the ambient
    // `this.io` which the foreground may have swapped while we awaited (D3). Raw
    // bytes go through `writeBytes` — no UTF-8 round-trip, so binary is byte-exact.
    if (out.byteLength > 0) io.stdout.writeBytes(out);
  }

  /**
   * D3: derive a child I/O context. The default shares the parent's sinks and fd
   * table (a nested foreground command); pass overrides to install a redirect /
   * capture sink or piped stdin. `fork:true` (background jobs, subshells)
   * SNAPSHOTS the fd table so the child's `exec`-style fd mutations stay private.
   */
  private deriveIo(
    parent: CommandIO,
    overrides: { stdout?: OutputSink | ((s: string) => void); stderr?: OutputSink | ((s: string) => void); stdin?: ReadableStream<Uint8Array> | undefined; fdTable?: Map<number, FdEntry> } = {},
    fork = false,
  ): CommandIO {
    return {
      stdout: overrides.stdout ? toSink(overrides.stdout) : parent.stdout,
      stderr: overrides.stderr ? toSink(overrides.stderr) : parent.stderr,
      stdin: 'stdin' in overrides ? overrides.stdin : parent.stdin,
      fdTable: overrides.fdTable ?? (fork ? new Map(parent.fdTable) : parent.fdTable),
    };
  }

  protected writeStdout(s: string): void { this.io.stdout(s); }
  protected writeStderr(s: string): void { this.io.stderr(s); }
}

/**
 * "Coreutils-shadowing" builtins: commands that exist BOTH as an in-process
 * builtin and as a spawnable external coreutils command. The builtin runs ONLY
 * when it behaves identically to the external — otherwise the executor falls
 * through to spawn the real external so file operands etc. are honored.
 *
 * `cat`: the builtin only echoes stdin. With NO operands that matches the
 * external's `cat` (stdin passthrough), so the builtin runs. WITH file operands
 * the builtin would print nothing, so we spawn the external coreutils `cat`,
 * which reads the files. A host with no coreutils loses `cat file` (acceptable:
 * the shell is meant to be used WITH coreutils), but `echo x | cat` still works.
 */
function builtinShadowsExternal(name: string, argv: string[]): boolean {
  if (name === 'cat') return argv.length === 0;
  return true;
}

function toSpawnParams(p: PipelineStageParams): SpawnParams {
  return { code: p.code, args: p.args, env: p.env, cwd: p.cwd, captureStdout: p.captureStdout, captureStderr: p.captureStderr, fds: p.fds };
}

function describeStages(stages: SimpleCommand[]): string {
  return stages.map((s) => [s.name, ...s.args].filter((w) => w !== '').join(' ')).join(' | ');
}

/** Reconstruct a readable command string for the history list. */
function describeStatement(stmt: Statement): string {
  if (stmt.type === 'Pipeline') return describeStages(stmt.stages ?? []);
  return stmt.type.toLowerCase();
}

/** test(1)-style argument evaluation for `[[ ]]` fallback (string truthiness, numeric/string comparisons). */
function evalTestArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== '';
  if (args.length === 3) {
    const [a, op, b] = args;
    switch (op) {
      case '=': case '==': return a === b;
      case '!=': return a !== b;
      default: return testNumericCompare(a, op, b) ?? false; // 64-bit -eq/-ne/-lt/…
    }
  }
  return false;
}
