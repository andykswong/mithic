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

import type { Program, Redirect, SimpleCommand, Statement } from './ast.ts';
import { parse } from './parser.ts';
import { evalArith } from './arith.ts';
import { globMatch } from './glob.ts';
import type { GlobOptions } from './glob.ts';
import { Expander, ExpansionError } from './expander.ts';
import { expandHistory, HistoryEventNotFound } from './history-expand.ts';
import { isBuiltin, runBuiltin, OPTION_FLAGS, SET_O_OPTIONS, SHOPT_NAMES, PosixSpecialBuiltinError } from './builtins.ts';
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
  sink?: (s: string) => void;
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
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin: string | undefined;
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
}

export type CommandResolver = (name: string) => string | URL | undefined;

export interface ExecutorOptions {
  resolve?: CommandResolver;
  onStdout?: (s: string) => void;
  onStderr?: (s: string) => void;
  fs?: FsClient;
  /**
   * A3 Tier 2: the shell's OWN stdin as a LIVE byte stream. When present, plain
   * `read` / `read -t` consume successive lines from it (a `read -t` over a
   * stream with no data yet times out), instead of the pre-materialized string
   * model. Here-docs / `pipeStdin` / `<` redirects still feed `read` via the
   * string path. Absent ⇒ plain `read` falls back to the string `ctx.stdin`.
   */
  stdinStream?: ReadableStream<Uint8Array>;
}

/**
 * A3 Tier 2: an incremental line reader over a live `ReadableStream<Uint8Array>`.
 * `readLine()` resolves the next `\n`-terminated line (newline stripped), or the
 * trailing partial line at EOF, or `undefined` once exhausted. A pull that has
 * no buffered line awaits the next chunk — so a `read -t` can race it against a
 * timer; a lost race does NOT drop data (consumed bytes stay in `#pending` and
 * any in-flight chunk read is cached).
 */
class StreamLineReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #dec = new TextDecoder();
  #pending = '';
  #eof = false;
  /** A chunk read started by a prior (possibly timed-out) call, not yet used. */
  #inflight: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readLine(): Promise<string | undefined> {
    for (;;) {
      const nl = this.#pending.indexOf('\n');
      if (nl >= 0) { const line = this.#pending.slice(0, nl); this.#pending = this.#pending.slice(nl + 1); return line; }
      if (this.#eof) { if (this.#pending.length > 0) { const l = this.#pending; this.#pending = ''; return l; } return undefined; }
      // Reuse an in-flight chunk read (a prior read -t may have abandoned it on a
      // timeout) so no chunk is lost; start a fresh one otherwise.
      const p = this.#inflight ?? this.#reader.read();
      this.#inflight = p;
      const { value, done } = await p;
      this.#inflight = undefined;
      if (done) { this.#eof = true; continue; }
      if (value && value.byteLength > 0) this.#pending += this.#dec.decode(value, { stream: true });
    }
  }

  cancel(): void { void this.#reader.cancel().catch(() => { /* closed */ }); }
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

export class Executor {
  readonly context: ShellContext;
  /** C4: the variable environment (vars/arrays/assoc/RANDOM/SHLVL) — the ShellEnv. */
  private environment: Environment;
  private kernel: KernelClient;
  private resolve: CommandResolver;
  private fs: FsClient | undefined;
  /** A3-T2: the shell's live stdin stream + its lazily-built line reader. */
  private stdinStream: ReadableStream<Uint8Array> | undefined;
  private stdinLineReader: StreamLineReader | undefined;
  /**
   * A3-T2: an in-flight `readLine()` a prior `read -t` started but abandoned when
   * its timer won. Cached so the NEXT plain read reuses the SAME promise (and the
   * line it eventually yields) instead of starting a fresh read that races the
   * orphan — mirrors the duplex-fd `pendingRead` cache. Cleared on consumption.
   */
  private stdinPendingLine: Promise<string | undefined> | undefined;
  private lastStatus = 0;
  private pipeStatus: number[] = [];
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
  /** `set` options. errexit aborts on nonzero; the rest per their POSIX meaning. */
  private options: Record<ShellOptionName, boolean> = {
    errexit: false,
    nounset: false,
    xtrace: false,
    pipefail: false,
    noclobber: false,
    verbose: false,
    posix: false,
    // History expansion (`!!`, `!n`, ...) — bash enables `histexpand` for
    // interactive shells. The Executor `exec()` entry IS the interactive REPL
    // line here, so default it on; `set +H` disables it (M13).
    histexpand: true,
  };
  /** `shopt` bash options (extglob/globstar/nullglob/dotglob/nocaseglob/nocasematch). */
  private shoptStore: Record<string, boolean> = {
    dotglob: false, extglob: false, globstar: false,
    nocaseglob: false, nocasematch: false, nullglob: false,
  };
  /** Trap handlers: signal name (EXIT/ERR/INT/...) → handler command string. */
  private traps = new Map<string, string>();
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
    this.resolve = options.resolve ?? ((name) => name);
    this.fs = options.fs;
    this.stdinStream = options.stdinStream;
    const stdout = options.onStdout ?? ((s: string) => {
      if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
    });
    const stderr = options.onStderr ?? ((s: string) => {
      if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s);
    });
    // The root ambient frame: terminal sinks, no piped stdin, the persistent fd table.
    this.io = { stdout, stderr, stdin: undefined, fdTable: this.fdTable };
    // C4: the job table + wait/jobs/kill/disown owner (signal delivery via kernel.kill).
    this.jobControl = new JobController(kernel.kill ? (pid, sig) => kernel.kill!(pid, sig) : undefined);
    // C4: the variable environment. The Executor is the EnvHost — it supplies the
    // status/positional specials and the cross-cutting glob / cmd-sub / flag
    // accessors so Environment stays a focused variable store.
    const host: EnvHost = {
      lastStatus: () => this.lastStatus,
      lastBgPid: () => this.jobControl.lastBgPid(),
      pipeStatus: () => this.pipeStatus,
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

  /** Run a command-sub body WITHOUT trailing-newline stripping (for procsub files). */
  private async runCommandSubRaw(src: string): Promise<string> {
    let out = '';
    // Capture into a derived child frame; stderr/fd-table inherit the ambient frame.
    const capIo = this.deriveIo(this.io, { stdout: (s) => { out += s; }, stdin: undefined });
    await this.run(this.parseSrc(src), true, capIo);
    return out;
  }

  /** Flush deferred `>(cmd)` process substitutions: feed each temp file to its cmd. */
  private async flushPendingProcSubs(): Promise<void> {
    if (this.pendingProcSubs.length === 0 || !this.fs) return;
    const pending = this.pendingProcSubs;
    this.pendingProcSubs = [];
    for (const { path, src } of pending) {
      let data = '';
      try { data = await Promise.resolve(this.fs.fsRead(this.fs.fsOpen(path, { read: true }))); } catch { data = ''; }
      const subIo = this.deriveIo(this.io, { stdin: data });
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
    const input = (await this.resolveStdin(stmt.redirects ?? [])) ?? io.stdin ?? '';
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
    // Capture into a derived child frame (stderr/fd-table inherit the ambient
    // frame). `run` saves+restores `this.io`, so the ambient frame is intact
    // afterward — and the capture buffer cannot be re-routed by an interleaving
    // foreground statement (D3).
    const capIo = this.deriveIo(this.io, { stdout: (s) => { out += s; }, stdin: undefined });
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

  private expander(): Expander { return new Expander(this.environment); }

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

  private declareLocal(name: string): void {
    if (this.localScopes.length === 0) return;
    const scope = this.localScopes[this.localScopes.length - 1];
    const saved = this.localSaved[this.localSaved.length - 1];
    if (!scope.has(name)) {
      scope.add(name);
      saved.set(name, name in this.context.env ? this.context.env[name] : undefined);
    }
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
    const env = this.arithEnvForExpr();
    if (stmt.arithInit) evalArith(stmt.arithInit, env);
    const cond = stmt.arithCond ?? '';
    let guard = 0;
    for (;;) {
      if (cond !== '' && evalArith(cond, env) === 0) break;
      if (++guard > 1_000_000) break;
      try {
        status = await this.execList(stmt.body ?? [], io);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); /* fall to incr */ }
        else throw e;
      }
      if (this.exiting !== undefined) return status;
      if (stmt.arithIncr) evalArith(stmt.arithIncr, env);
    }
    return status;
  }

  /** A live env proxy (bare-name read/write to the shell env) for arithmetic-for. */
  private arithEnvForExpr(): Record<string, string> {
    return new Proxy({}, {
      get: (_t, p: string) => this.context.env[p] ?? '',
      set: (_t, p: string, v) => { this.context.env[p] = String(v); return true; },
      has: (_t, p: string) => p in this.context.env,
    }) as Record<string, string>;
  }

  private async execCase(stmt: Statement, io: CommandIO): Promise<number> {
    const exp = this.expander();
    const word = await exp.expandToString(stmt.caseWord!);
    for (const clause of stmt.clauses ?? []) {
      for (const rawPat of clause.patterns) {
        const pat = await exp.expandToString(rawPat);
        if (globMatch(word, pat, this.globMatchOpts())) {
          return this.execList(clause.body, io);
        }
      }
    }
    return 0;
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
      let status = await this.execList(stmt.body ?? [], subIo);
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
      try { return new RegExp(words[2]).test(words[0]); } catch { return false; }
    }
    if (words.length === 3 && (words[1] === '==' || words[1] === '=')) {
      return globMatch(words[0], words[2], this.globMatchOpts());
    }
    if (words.length === 3 && words[1] === '!=') {
      return !globMatch(words[0], words[2], this.globMatchOpts());
    }
    if (words.length === 2 && words[0].startsWith('-')) {
      return this.condFileTest(words[0], words[1]);
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
      restore = await this.applyRedirects(redirects, io);
    } catch (e) {
      if (e instanceof RedirectError) { io.stderr(`shell: ${e.message}\n`); return 1; }
      throw e;
    }
    try { return await fn(io); } finally { restore(); }
  }

  /**
   * Snapshot the current write sink for a numbered fd (1=stdout, 2=stderr,
   * N=fdTable). Returns the concrete function NOW (not a live reference), so a
   * dup like `exec 3>&1` captures stdout's current target without forming a
   * self-referential loop when stdout is later redirected to fd 3.
   */
  private sinkForFd(fd: number, io: CommandIO): (s: string) => void {
    if (fd === 1) return io.stdout;
    if (fd === 2) return io.stderr;
    const entry = io.fdTable.get(fd);
    if (entry?.sink) return entry.sink;
    return () => { /* fd not open for writing — discard */ };
  }

  /** Point a numbered fd at a sink in `io` (temporary, for the duration of a command). */
  private setFdSink(fd: number, sink: (s: string) => void, io: CommandIO): void {
    if (fd === 1) io.stdout = sink;
    else if (fd === 2) io.stderr = sink;
    else { const e = io.fdTable.get(fd) ?? { mode: 'write' as const }; e.sink = sink; io.fdTable.set(fd, e); }
  }

  /**
   * Apply a set of redirects, returning a restore function. Supports `>` `>>`
   * `>|` `<` `<>` `<<` `<<<` `N>` `N>>` `&>` `&>>` (append, M9) `N>&M` (dup)
   * `N>&-` (close), numbered fds via the per-shell {@link fdTable}, and the
   * `/dev/null`/`/dev/stdout`/`/dev/stderr` device paths.
   */
  private async applyRedirects(redirects: Redirect[], io: CommandIO): Promise<() => void> {
    const exp = this.expander();
    const savedStdout = io.stdout;
    const savedStderr = io.stderr;
    const savedFds = new Map<number, FdEntry | undefined>();
    const closers: Array<() => void> = [];
    const snapshotFd = (fd: number): void => { if (fd !== 1 && fd !== 2 && !savedFds.has(fd)) savedFds.set(fd, io.fdTable.get(fd)); };
    // `/dev/stdout` / `/dev/stderr` redirect targets resolve to the frame's
    // ORIGINAL sinks (captured now), so `cmd 1>&2 2>file` and `> /dev/stdout`
    // behave like the unredirected destinations rather than chasing the live frame.
    const base: CommandIO = { stdout: savedStdout, stderr: savedStderr, stdin: io.stdin, fdTable: io.fdTable };

    for (const r of redirects) {
      if (r.op === '<' || r.op === '<<' || r.op === '<<<' || r.op === '<>') continue; // stdin handled per-command

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
      if (r.op === '&>' || r.op === '&>>') { io.stdout = sink; io.stderr = sink; }
      else { snapshotFd(fd); this.setFdSink(fd, sink, io); }
    }

    return () => {
      for (const c of closers) c();
      io.stdout = savedStdout;
      io.stderr = savedStderr;
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
          const entry: FdEntry = { mode: 'rw', duplex, sink: (s) => { void Promise.resolve(duplex.write(s)); }, close: () => { void Promise.resolve(duplex.close()); } };
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
  private makeExecFileSink(path: string, seed: string, io: CommandIO): (s: string) => void {
    if (path === '/dev/null') return () => { /* discard */ };
    if (path === '/dev/stdout') return (s) => io.stdout(s);
    if (path === '/dev/stderr') return (s) => io.stderr(s);
    const fs = this.fs;
    if (!fs) throw new Error(`shell: exec redirect to '${path}' requires an FsClient`);
    let buffer = seed;
    return (s) => {
      buffer += s;
      const fd = fs.fsOpen(path, { write: true, create: true, truncate: true });
      fs.fsWrite(fd, buffer);
      fs.fsClose(fd);
    };
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
      const p = entry.pendingRead ?? Promise.resolve(entry.duplex.readLine());
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
   * A3 Tier 2: read one line of PLAIN stdin (no `-u`) for the `read` builtin.
   *
   * Precedence:
   *   1. An active STRING stdin (`stringStdin` — a here-doc / `pipeStdin` / `<`
   *      redirect): serve the first line. A `-t` over a materialized string is
   *      immediate (data is already here or it is EOF) — never a timeout.
   *   2. Otherwise the shell's LIVE stdin stream: read the next line, racing a
   *      `-t` timer when set. On timeout, `timedOut` is true and the in-flight
   *      chunk read is retained (no data dropped). No stream ⇒ EOF.
   */
  async readStdinLine(stringStdin: string | undefined, timeoutSec: number | undefined): Promise<{ line: string | undefined; timedOut: boolean }> {
    if (stringStdin !== undefined) {
      const nl = stringStdin.indexOf('\n');
      if (stringStdin === '') return { line: undefined, timedOut: false };
      return { line: nl >= 0 ? stringStdin.slice(0, nl) : stringStdin, timedOut: false };
    }
    if (!this.stdinStream) return { line: undefined, timedOut: false };
    if (!this.stdinLineReader) this.stdinLineReader = new StreamLineReader(this.stdinStream);
    // Reuse any in-flight line read a prior timed-out read abandoned (no data
    // dropped); start a fresh one otherwise.
    const readP = this.stdinPendingLine ?? this.stdinLineReader.readLine();
    this.stdinPendingLine = readP;
    if (timeoutSec === undefined) {
      const line = await readP;
      this.stdinPendingLine = undefined; // consumed
      return { line, timedOut: false };
    }
    const timedOut = Symbol('t');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timerP = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), Math.max(0, timeoutSec * 1000)); });
    const r = await Promise.race([readP, timerP]);
    if (timer !== undefined) clearTimeout(timer);
    if (r === timedOut) return { line: undefined, timedOut: true }; // leave pending cached
    this.stdinPendingLine = undefined; // consumed
    return { line: r, timedOut: false };
  }

  private makeFileSink(path: string, append: boolean, closers: Array<() => void>, io: CommandIO): (s: string) => void {
    if (path === '/dev/null') return () => { /* discard */ };
    if (path === '/dev/stdout') return (s) => io.stdout(s);
    if (path === '/dev/stderr') return (s) => io.stderr(s);
    const fs = this.fs;
    if (!fs) throw new Error(`shell: redirect to '${path}' requires an FsClient (pass 'fs' in ExecutorOptions)`);
    const fd = fs.fsOpen(path, { write: !append, append, create: true, truncate: !append });
    closers.push(() => fs.fsClose(fd));
    return (s) => fs.fsWrite(fd, s);
  }

  /** Resolve a command's stdin source from its input redirects (<, <<, <<<). */
  private async resolveStdin(redirects: Redirect[]): Promise<string | undefined> {
    const exp = this.expander();
    let stdin: string | undefined;
    for (const r of redirects) {
      if (r.op === '<<<') {
        stdin = await exp.expandToString(r.target) + '\n';
      } else if (r.op === '<<') {
        stdin = r.hereDocQuoted ? (r.hereDoc ?? '') : await this.expandHereDoc(r.hereDoc ?? '');
      } else if (r.op === '<' || r.op === '<>') {
        const path = await exp.expandToString(r.target);
        if (path === '/dev/null') { stdin = ''; continue; }
        const fs = this.fs;
        if (!fs) throw new Error(`shell: input redirect from '${path}' requires an FsClient`);
        try { stdin = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true }))); }
        catch { if (r.op === '<>') stdin = ''; else throw new RedirectError(`${path}: No such file or directory`); }
      }
    }
    return stdin;
  }

  /**
   * D8: resolve an EXTERNAL command's fd-0 (stdin) source into a kernel fd spec.
   * A `<` redirect becomes an `open` of the (cwd-resolved) path — the kernel
   * streams the file into fd 0; a `<<`/`<<<` body becomes `bytes` fed into fd 0.
   * With no input redirect, an inherited piped-stdin STRING (`pipedStdin`, from a
   * compound-pipeline stage) is encoded to `bytes` so it still reaches the child.
   * Returns undefined when there is no stdin source (the child gets an EOF).
   *
   * `/dev/null` resolves to an empty `bytes` spec (immediate EOF) — the kernel's
   * VFS has no `/dev/null` handle to `open`.
   */
  private async resolveStdinFd(redirects: Redirect[], pipedStdin: string | undefined): Promise<StdinFdSpec | undefined> {
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
    if (pipedStdin !== undefined) return { action: 'bytes', data: new TextEncoder().encode(pipedStdin) };
    return undefined;
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
   * Run a pipeline whose stages are full command nodes (M1) in-process: each
   * stage's stdout (and, for a `|&` join, its stderr) is captured and fed to the
   * next stage as stdin. The pipeline's status is the last stage's (or, under
   * pipefail, the last nonzero). Compound stages (subshells/groups/if/…) run via
   * {@link execStatement}; the captured stdin is exposed via {@link pipeStdin}.
   */
  private async execNodePipeline(nodes: Statement[], pipeStderr: boolean[], io: CommandIO): Promise<number> {
    let stdin: string | undefined;
    const codes: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const isLast = i === nodes.length - 1;
      let captured = '';
      // Each stage runs against its OWN derived frame: a non-final stage captures
      // its stdout (and, for `prev |& next`, its stderr) into the buffer that
      // feeds the next stage's stdin; the final stage writes to `io`. No shared
      // instance fields are mutated, so a backgrounded stage cannot misroute.
      const stageIo = this.deriveIo(io, {
        stdout: isLast ? io.stdout : (s) => { captured += s; },
        stderr: (!isLast && pipeStderr[i]) ? (s) => { captured += s; } : io.stderr,
        stdin: i === 0 ? undefined : stdin,
      });
      const code = await this.execStatement(nodes[i], stageIo);
      codes.push(code);
      if (this.exiting !== undefined) { this.pipeStatus = codes; return code; }
      stdin = captured;
    }
    this.pipeStatus = codes;
    return this.pipelineStatus(codes, codes[codes.length - 1] ?? 0);
  }

  private async execMultiStagePipeline(stages: SimpleCommand[], io: CommandIO): Promise<number> {
    const expander = this.expander();
    const expanded: Array<{ name: string; argv: string[]; env: Record<string, string> }> = [];
    for (const s of stages) expanded.push(await this.expandCommand(s, expander));

    if (this.options.xtrace) {
      for (const e of expanded) io.stderr('+ ' + [e.name, ...e.argv].join(' ') + '\n');
    }

    if (expanded.every((e) => (isBuiltin(e.name) && builtinShadowsExternal(e.name, e.argv)) || this.functions.has(e.name))) {
      let stdin = '';
      let status = 0;
      const codes: number[] = [];
      for (let i = 0; i < expanded.length; i++) {
        const isLast = i === expanded.length - 1;
        const { name, argv } = expanded[i];
        let captured = '';
        // Each builtin stage gets a derived frame: non-final stages capture into
        // the buffer feeding the next stage; the final stage writes to `io`.
        const stageIo = this.deriveIo(io, { stdout: isLast ? io.stdout : (s) => { captured += s; }, stdin });
        status = await this.dispatch(name, argv, stageIo, { stdin });
        codes.push(status);
        if (this.exiting !== undefined) { this.pipeStatus = codes; return status; }
        stdin = captured;
      }
      this.pipeStatus = codes;
      return this.pipelineStatus(codes, status);
    }

    // D8: a `<` / `<<` / `<<<` redirect on the FIRST stage becomes that stage's
    // fd-0 source (later stages read the previous stage's pipe). Without this a
    // stdin-reading head (`grep foo < file | sort`) would block. The kernel
    // pipe-feeds it — an `open` is streamed in-kernel, a `<<`/`<<<` body is
    // fed as bytes.
    const headFd0 = await this.resolveStdinFd(stages[0].redirects, undefined);

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
    const expander = this.expander();

    // Scalar prefix assignments become a temporary overlay for a command, or are
    // applied to the env for a bare assignment. Array / element / append forms
    // only make sense as bare assignments (handled below).
    const localEnv: Record<string, string> = {};
    for (const a of cmd.assignments) {
      if (a.array === undefined && a.index === undefined && !a.append) {
        localEnv[a.name] = await expander.expandToString(a.value);
      }
    }

    const hasCommand = cmd.name !== '';
    const argExpander = hasCommand && Object.keys(localEnv).length > 0
      ? new Expander(this.environment.child(localEnv))
      : expander;

    const { name, argv } = await this.expandCommand(cmd, argExpander);

    if (name === '') {
      if (this.options.xtrace && cmd.assignments.length > 0) {
        io.stderr('+ ' + cmd.assignments.map((a) => `${a.name}=${a.value}`).join(' ') + '\n');
      }
      // A bare `x=$(cmd)` takes its status from the LAST command substitution in
      // the RHS (M10): `x=$(false); echo $?` → 1. With no command sub, status 0.
      this.lastCmdSubStatus = undefined;
      for (const a of cmd.assignments) await this.applyAssignment(a, expander);
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
    // compound-pipeline stage's piped stdin (M1). BUILTINS consume the string
    // (`read`/`cat`-builtin); EXTERNALS get a kernel fd-0 spec instead (D8): a
    // `<` redirect opens the VFS path in-kernel (streamed), a `<<`/`<<<` body or
    // an inherited piped-stdin string is fed as fd-0 bytes — no inline copy.
    const redirStdin = await this.resolveStdin(cmd.redirects);
    const stdin = redirStdin ?? io.stdin;

    // Apply output redirects to this command's frame. A refused redirect
    // (noclobber) aborts the command with status 1 — it never runs.
    let restore: (() => void) | undefined;
    if (cmd.redirects.length) {
      try {
        restore = await this.applyRedirects(cmd.redirects, io);
      } catch (e) {
        if (e instanceof RedirectError) { io.stderr(`shell: ${e.message}\n`); return 1; }
        throw e;
      }
    }
    try {
      if (this.functions.has(name)) {
        return await this.callFunction(name, argv, localEnv, io);
      }
      if (isBuiltin(name) && builtinShadowsExternal(name, argv)) {
        const saved = { ...this.context.env };
        Object.assign(this.context.env, localEnv);
        const status = await this.dispatch(name, argv, io, { stdin });
        if (cmd.assignments.length > 0 && name !== 'export' && name !== 'unset' && name !== 'local'
          && name !== 'declare' && name !== 'readonly') {
          for (const k of Object.keys(this.context.env)) if (!(k in saved)) delete this.context.env[k];
          for (const k of Object.keys(saved)) this.context.env[k] = saved[k];
        }
        return status;
      }
      const fd0 = await this.resolveStdinFd(cmd.redirects, io.stdin);
      return await this.spawnExternal(name, argv, localEnv, io, fd0);
    } finally {
      if (restore) restore();
      // Run any deferred `>(cmd)` substitutions now that the outer command has
      // written to their temp files (and the redirect sinks have flushed).
      await this.flushPendingProcSubs();
    }
  }

  /**
   * Apply a (bare) assignment to persistent shell state, handling all forms:
   *   - `name=v` / `name+=v`            scalar (append concatenates)
   *   - `name=(w…)` / `name+=(w…)`      indexed array literal (append extends)
   *   - `name[i]=v` / `name[i]+=v`      element assignment (append concatenates)
   * Array element words are field-expanded (so `arr=($x)` splits), scalar values
   * are expanded to a single string.
   */
  private async applyAssignment(a: { name: string; value: string; array?: string[]; index?: string; append?: boolean }, expander: Expander): Promise<void> {
    this.declareLocal(a.name);
    if (a.array !== undefined) {
      const elems: string[] = [];
      for (const w of a.array) elems.push(...await expander.expandWord(w));
      const prev = a.append ? (this.arrays.get(a.name) ?? []) : [];
      this.arrays.set(a.name, [...prev, ...elems]);
      delete this.context.env[a.name];
      return;
    }
    if (a.index !== undefined) {
      // Associative array element (`name[key]=v`, name declared via `declare -A`):
      // the subscript is a STRING key, not a numeric index (G6).
      const assoc = this.assocArrays.get(a.name);
      if (assoc !== undefined) {
        const key = await expander.substituteOnly(a.index);
        const val = await expander.expandToString(a.value);
        assoc.set(key, a.append ? (assoc.get(key) ?? '') + val : val);
        return;
      }
      const idx = parseInt(await expander.substituteOnly(a.index), 10) || 0;
      const arr = this.arrays.get(a.name) ?? (this.context.env[a.name] !== undefined ? [this.context.env[a.name]] : []);
      const val = await expander.expandToString(a.value);
      arr[idx] = a.append ? (arr[idx] ?? '') + val : val;
      this.arrays.set(a.name, arr);
      delete this.context.env[a.name];
      return;
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
      return;
    }
    this.context.env[a.name] = a.append ? (this.context.env[a.name] ?? '') + val : val;
  }

  private async spawnExternal(name: string, argv: string[], localEnv: Record<string, string>, io: CommandIO, fd0?: StdinFdSpec): Promise<number> {
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
    if (out.byteLength > 0) io.stderr(new TextDecoder().decode(out));
  }

  /**
   * A1: drain a live child-stdout ReadableStream into the command's stdout sink
   * (the EXPLICIT frame `io`, captured here so a post-await chunk lands in this
   * command's sink — not whatever the foreground swapped the ambient frame to,
   * D3), decoding incrementally (UTF-8 stream mode) so multi-byte chars spanning
   * a chunk boundary aren't mangled. Cancels the stream if the sink throws (a
   * broken downstream), propagating EPIPE up to the child via portToReadable.
   */
  private async pumpToStdout(stream: ReadableStream<Uint8Array>, io: CommandIO): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) io.stdout(dec.decode(value, { stream: true }));
      }
      const tail = dec.decode();
      if (tail) io.stdout(tail);
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
      // restore locals
      const scope = this.localScopes.pop()!;
      const saved = this.localSaved.pop()!;
      for (const k of scope) {
        const v = saved.get(k);
        if (v === undefined) delete this.context.env[k];
        else this.context.env[k] = v;
      }
      for (const k of overlayKeys) {
        if (savedOverlay[k] === undefined) delete this.context.env[k];
        else this.context.env[k] = savedOverlay[k]!;
      }
      this.context.positional = savedPositional;
    }
    return status;
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
    const external = await this.backgroundExternal(stmt);
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
  private async pumpReaderToSink(reader: ReadableStreamDefaultReader<Uint8Array>, sink: (s: string) => void): Promise<void> {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) sink(dec.decode(value, { stream: true }));
      }
      const tail = dec.decode();
      if (tail) sink(tail);
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
      sink: (s: string) => { void Promise.resolve(handle.write(s)); },
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

  private async expandCommand(cmd: SimpleCommand, expander: Expander): Promise<{ name: string; argv: string[]; env: Record<string, string> }> {
    const env: Record<string, string> = {};
    // Only scalar prefix assignments form the command-prefix env overlay; array /
    // element / append forms are handled as bare assignments by the executor.
    for (const a of cmd.assignments) {
      if (a.array === undefined && a.index === undefined && !a.append) {
        env[a.name] = await expander.expandToString(a.value);
      }
    }
    const nameFields = cmd.name === '' ? [] : await expander.expandWord(cmd.name);
    const name = nameFields[0] ?? '';
    const argv: string[] = [...nameFields.slice(1)];
    for (const arg of cmd.args) argv.push(...await expander.expandWord(arg));
    return { name, argv, env };
  }

  /**
   * Dispatch a builtin (with loop/return control surfaced as exceptions) against
   * the command's I/O `frame`. The builtin's `write`/`writeErr`/`readFdLine`
   * route through `frame` so a redirect / pipeline-stage capture / background
   * job's sinks are honored without touching shared instance fields. `opts.write`
   * (a pipeline capture sink) overrides the frame's stdout. The ambient `this.io`
   * is set to `frame` so a builtin's `eval` / `source` runs against it too.
   */
  private async dispatch(name: string, argv: string[], frame: CommandIO, opts: { stdin?: string; write?: (s: string) => void } = {}): Promise<number> {
    this.io = frame;
    const ctx: BuiltinContext = {
      cwd: this.context.cwd,
      env: this.context.env,
      write: opts.write ?? ((s) => frame.stdout(s)),
      writeErr: (s) => frame.stderr(s),
      stdin: opts.stdin,
      lastStatus: this.lastStatus,
      exit: (code) => { this.exiting = code; },
      eval: (src) => this.run(this.parseSrc(src), true),
      sourceFile: (args) => this.sourceFile(args),
      readFdLine: (fd) => this.readFdLine(fd, frame),
      consumeFdLine: (fd) => this.consumeFdLine(fd, frame),
      readStdinLine: (s, t) => this.readStdinLine(s, t),
      doBreak: (n) => { throw new LoopBreak(n); },
      doContinue: (n) => { throw new LoopContinue(n); },
      doReturn: (n) => { throw new FuncReturn(n); },
      state: this.shellState(),
    };
    const status = await runBuiltin(name, argv, ctx);
    this.context.cwd = ctx.cwd;
    return status;
  }

  private async writeCaptured(bytes: Promise<Uint8Array>, io: CommandIO): Promise<void> {
    const out = await bytes;
    // Post-await: write through the EXPLICIT (captured) frame, not the ambient
    // `this.io` which the foreground may have swapped while we awaited (D3).
    if (out.byteLength > 0) io.stdout(new TextDecoder().decode(out));
  }

  /**
   * D3: derive a child I/O context. The default shares the parent's sinks and fd
   * table (a nested foreground command); pass overrides to install a redirect /
   * capture sink or piped stdin. `fork:true` (background jobs, subshells)
   * SNAPSHOTS the fd table so the child's `exec`-style fd mutations stay private.
   */
  private deriveIo(parent: CommandIO, overrides: Partial<CommandIO> = {}, fork = false): CommandIO {
    return {
      stdout: overrides.stdout ?? parent.stdout,
      stderr: overrides.stderr ?? parent.stderr,
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
      case '-eq': return Number(a) === Number(b);
      case '-ne': return Number(a) !== Number(b);
      case '-lt': return Number(a) < Number(b);
      case '-le': return Number(a) <= Number(b);
      case '-gt': return Number(a) > Number(b);
      case '-ge': return Number(a) >= Number(b);
      default: return false;
    }
  }
  return false;
}
