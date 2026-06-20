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
import { Expander, ExpansionError } from './expander.ts';
import type { ShellEnv } from './expander.ts';
import { isBuiltin, runBuiltin, OPTION_FLAGS, SET_O_OPTIONS, SHOPT_NAMES } from './builtins.ts';
import type { BuiltinContext, ShellState, ShellOptionName } from './builtins.ts';
import type {
  FsClient,
  KernelClient,
  PipelineStageParams,
  SpawnParams,
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
}

export interface Job {
  id: number;
  pids: number[];
  command: string;
  state: 'running' | 'done' | 'stopped';
  exitCode?: number;
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

export class Executor implements ShellEnv {
  readonly context: ShellContext;
  private kernel: KernelClient;
  private resolve: CommandResolver;
  private fs: FsClient | undefined;
  private lastStatus = 0;
  private pipeStatus: number[] = [];
  private lastBgPid = 0;
  /** Status of the most recent command substitution (`$(...)`), for M10. */
  private lastCmdSubStatus: number | undefined;
  private exiting: number | undefined;
  private stdoutSink: (s: string) => void;
  private stderrSink: (s: string) => void;
  private functions = new Map<string, ShellFunction>();
  /** Indexed arrays (`arr=(a b c)`), kept separate from scalar `context.env`. */
  private arrays = new Map<string, string[]>();
  private localScopes: Array<Set<string>> = [];
  private localSaved: Array<Map<string, string | undefined>> = [];
  private jobs: Job[] = [];
  private nextJobId = 1;
  /** `set` options. errexit aborts on nonzero; the rest per their POSIX meaning. */
  private options: Record<ShellOptionName, boolean> = {
    errexit: false,
    nounset: false,
    xtrace: false,
    pipefail: false,
    noclobber: false,
    verbose: false,
    posix: false,
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
  /** Per-shell numbered file-descriptor table (fd → sink/source), for exec/>&N. */
  private fdTable = new Map<number, FdEntry>();

  constructor(kernel: KernelClient, context: ShellContext, options: ExecutorOptions = {}) {
    this.kernel = kernel;
    this.context = context;
    this.resolve = options.resolve ?? ((name) => name);
    this.fs = options.fs;
    this.stdoutSink = options.onStdout ?? ((s) => {
      if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
    });
    this.stderrSink = options.onStderr ?? ((s) => {
      if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s);
    });
  }

  // ── ShellEnv implementation (for the Expander) ──────────────────────────────

  get(name: string): string | undefined { return this.context.env[name]; }
  set(name: string, value: string): void { this.context.env[name] = value; }
  has(name: string): boolean { return name in this.context.env; }
  getArray(name: string): string[] | undefined { return this.arrays.get(name); }
  get cwd(): string { return this.context.cwd; }

  getSpecial(name: string): string | undefined {
    switch (name) {
      case '?': return String(this.lastStatus);
      case '#': return String((this.context.positional ?? []).length);
      case '$': return String(this.context.pid ?? 0);
      // `$!` is empty (not "0") until a background job has been started.
      case '!': return this.lastBgPid === 0 ? '' : String(this.lastBgPid);
      case '-': return this.currentFlags();
      case '0': return this.context.name ?? 'sh';
      case '@':
      case '*': return (this.context.positional ?? []).join(' ');
      case 'PIPESTATUS': return this.pipeStatus.join(' ');
    }
    if (/^[1-9][0-9]*$/.test(name)) {
      return (this.context.positional ?? [])[parseInt(name, 10) - 1];
    }
    if (name === 'PIPESTATUS') return this.pipeStatus.join(' ');
    return undefined;
  }

  getPositional(): string[] { return this.context.positional ?? []; }

  /** True when `set -u` (nounset) is active — the expander errors on unset vars. */
  nounset(): boolean { return this.options.nounset; }

  /** True when POSIX mode is active — the expander disables brace expansion. */
  posix(): boolean { return this.options.posix; }

  /** Read a `shopt` glob option (extglob/globstar/nullglob/dotglob/...). */
  shopt(name: string): boolean { return this.shoptStore[name] ?? false; }

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

  private async execSelect(stmt: Statement): Promise<number> {
    // No interactive TTY in this runtime: print the numbered menu to stderr and
    // run the body once with the variable unset (read returns EOF), then stop.
    const exp = this.expander();
    let words: string[];
    if (stmt.words === undefined) words = this.getPositional();
    else { words = []; for (const w of stmt.words) words.push(...await exp.expandWord(w)); }
    for (let k = 0; k < words.length; k++) this.writeStderr(`${k + 1}) ${words[k]}\n`);
    this.context.env[stmt.varName!] = '';
    return 0;
  }

  async runCommandSub(src: string): Promise<string> {
    let out = '';
    const savedStdout = this.stdoutSink;
    this.stdoutSink = (s) => { out += s; };
    // `$(< file)` fast-read form (M5): an empty command body whose only content
    // is a single `< file` input redirect reads the file directly.
    const fast = src.match(/^\s*<\s*(\S+)\s*$/);
    try {
      if (fast) {
        this.lastCmdSubStatus = await this.readFileForCmdSub(fast[1]);
      } else {
        this.lastCmdSubStatus = await this.run(this.parseSrc(src), /*nested*/ true);
      }
    } finally {
      this.stdoutSink = savedStdout;
    }
    return out;
  }

  /** Read a file for `$(< file)`, writing its contents to the (captured) sink. Returns status. */
  private async readFileForCmdSub(rawPath: string): Promise<number> {
    const path = await this.expander().expandToString(rawPath);
    const fs = this.fs;
    if (!fs) return 1;
    try {
      const data = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true })));
      this.writeStdout(data);
      return 0;
    } catch {
      this.writeStderr(`shell: ${path}: No such file or directory\n`);
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

  private expander(): Expander { return new Expander(this); }

  // ── ShellState (for builtins that need richer state) ────────────────────────

  private shellState(): ShellState {
    return {
      functions: this.functions,
      jobs: this.jobs,
      positional: this.context.positional ?? [],
      setPositional: (p) => { this.context.positional = p; },
      shiftPositional: (n) => {
        const p = this.context.positional ?? [];
        this.context.positional = p.slice(n);
      },
      declareLocal: (name) => this.declareLocal(name),
      waitJob: (id) => this.waitForJob(id),
      waitAll: () => this.waitAllJobs(),
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
      removeJob: (spec) => {
        const idx = this.jobs.findIndex((j) => j.id === spec || j.pids.includes(spec));
        if (idx < 0) return false;
        this.jobs.splice(idx, 1);
        return true;
      },
      killJob: (spec, _signal) => {
        const job = this.jobs.find((j) => j.id === spec || j.pids.includes(spec));
        if (!job) return false;
        job.state = 'done';
        return true;
      },
    };
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

  async run(program: Program, nested = false): Promise<number> {
    try {
      for (const stmt of program.body) {
        if (!nested) this.addHistory(describeStatement(stmt));
        try {
          this.lastStatus = await this.execStatement(stmt);
        } catch (e) {
          if (e instanceof ExpansionError) {
            // `set -u` unbound var / `${v:?}` — write to stderr and abort nonzero.
            this.writeStderr(`shell: ${e.message}\n`);
            this.lastStatus = 1;
            if (!nested) { this.exiting = 1; return 1; }
            return 1;
          }
          if (e instanceof SyntaxError) {
            // POSIX-mode rejection / bad redirect → diagnostic + nonzero (H1/C2).
            this.writeStderr(`${e.message}\n`);
            this.lastStatus = 2;
            if (!nested) { this.exiting = 2; return 2; }
            return 2;
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

  private async execStatement(stmt: Statement): Promise<number> {
    switch (stmt.type) {
      case 'Pipeline': return this.withRedirects(stmt, () => this.execPipeline(stmt));
      case 'And': {
        const l = await this.execStatement(stmt.left!);
        if (this.exiting !== undefined) return l;
        return l === 0 ? this.execStatement(stmt.right!) : l;
      }
      case 'Or': {
        const l = await this.execStatement(stmt.left!);
        if (this.exiting !== undefined) return l;
        return l !== 0 ? this.execStatement(stmt.right!) : l;
      }
      case 'If': return this.execIf(stmt);
      case 'While': return this.withRedirects(stmt, () => this.execWhile(stmt));
      case 'For': return this.withRedirects(stmt, () => this.execFor(stmt));
      case 'Select': return this.withRedirects(stmt, () => this.execSelect(stmt));
      case 'Case': return this.execCase(stmt);
      case 'Function': {
        this.functions.set(stmt.funcName!, { name: stmt.funcName!, body: stmt.funcBody! });
        return 0;
      }
      case 'Subshell': return this.execSubshell(stmt);
      case 'Group': return this.withRedirects(stmt, () => this.execList(stmt.body ?? []));
      case 'Arithmetic': return this.execArithCmd(stmt);
      case 'Cond': return this.execCond(stmt);
      default: return 0;
    }
  }

  private async execList(list: Statement[]): Promise<number> {
    let status = 0;
    for (const s of list) {
      status = await this.execStatement(s);
      this.lastStatus = status;
      if (this.exiting !== undefined) return status;
    }
    return status;
  }

  private async execIf(stmt: Statement): Promise<number> {
    const cond = await this.execList(stmt.condition ?? []);
    if (this.exiting !== undefined) return cond;
    if (cond === 0) return this.execList(stmt.then ?? []);
    if (stmt.else) return this.execList(stmt.else);
    return 0;
  }

  private async execWhile(stmt: Statement): Promise<number> {
    let status = 0;
    const until = stmt.until === true;
    for (;;) {
      const cond = await this.execList(stmt.condition ?? []);
      if (this.exiting !== undefined) return cond;
      const enter = until ? cond !== 0 : cond === 0;
      if (!enter) break;
      try {
        status = await this.execList(stmt.body ?? []);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); continue; }
        throw e;
      }
      if (this.exiting !== undefined) return status;
    }
    return status;
  }

  private async execFor(stmt: Statement): Promise<number> {
    let status = 0;
    const exp = this.expander();
    let words: string[];
    if (stmt.words === undefined) {
      words = this.getPositional();
    } else {
      words = [];
      for (const w of stmt.words) words.push(...await exp.expandWord(w));
    }
    for (const word of words) {
      this.context.env[stmt.varName!] = word;
      try {
        status = await this.execList(stmt.body ?? []);
      } catch (e) {
        if (e instanceof LoopBreak) { if (e.count > 1) throw new LoopBreak(e.count - 1); break; }
        if (e instanceof LoopContinue) { if (e.count > 1) throw new LoopContinue(e.count - 1); continue; }
        throw e;
      }
      if (this.exiting !== undefined) return status;
    }
    return status;
  }

  private async execCase(stmt: Statement): Promise<number> {
    const exp = this.expander();
    const word = await exp.expandToString(stmt.caseWord!);
    for (const clause of stmt.clauses ?? []) {
      for (const rawPat of clause.patterns) {
        const pat = await exp.expandToString(rawPat);
        if (matchCasePattern(word, pat)) {
          return this.execList(clause.body);
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
  private async execSubshell(stmt: Statement): Promise<number> {
    const savedEnv = { ...this.context.env };
    const savedCwd = this.context.cwd;
    const savedPositional = this.context.positional ? [...this.context.positional] : undefined;
    const savedOptions = { ...this.options };
    const savedShopt = { ...this.shoptStore };
    const savedFunctions = new Map(this.functions);
    const savedArrays = new Map(this.arrays);
    const savedExiting = this.exiting;
    this.exiting = undefined;
    try {
      let status = await this.execList(stmt.body ?? []);
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
      return matchCasePattern(words[0], words[2]);
    }
    if (words.length === 3 && words[1] === '!=') {
      return !matchCasePattern(words[0], words[2]);
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

  /** Run `fn` with the statement's compound redirects applied to the output sinks. */
  private async withRedirects(stmt: Statement, fn: () => Promise<number>): Promise<number> {
    const redirects = stmt.redirects;
    if (!redirects || redirects.length === 0) return fn();
    let restore: () => void;
    try {
      restore = await this.applyRedirects(redirects);
    } catch (e) {
      if (e instanceof RedirectError) { this.writeStderr(`shell: ${e.message}\n`); return 1; }
      throw e;
    }
    try { return await fn(); } finally { restore(); }
  }

  /**
   * Snapshot the current write sink for a numbered fd (1=stdout, 2=stderr,
   * N=fdTable). Returns the concrete function NOW (not a live reference), so a
   * dup like `exec 3>&1` captures stdout's current target without forming a
   * self-referential loop when stdout is later redirected to fd 3.
   */
  private sinkForFd(fd: number): (s: string) => void {
    if (fd === 1) return this.stdoutSink;
    if (fd === 2) return this.stderrSink;
    const entry = this.fdTable.get(fd);
    if (entry?.sink) return entry.sink;
    return () => { /* fd not open for writing — discard */ };
  }

  /** Point a numbered fd at a sink (temporary, for the duration of a command). */
  private setFdSink(fd: number, sink: (s: string) => void): void {
    if (fd === 1) this.stdoutSink = sink;
    else if (fd === 2) this.stderrSink = sink;
    else { const e = this.fdTable.get(fd) ?? { mode: 'write' as const }; e.sink = sink; this.fdTable.set(fd, e); }
  }

  /**
   * Apply a set of redirects, returning a restore function. Supports `>` `>>`
   * `>|` `<` `<>` `<<` `<<<` `N>` `N>>` `&>` `&>>` (append, M9) `N>&M` (dup)
   * `N>&-` (close), numbered fds via the per-shell {@link fdTable}, and the
   * `/dev/null`/`/dev/stdout`/`/dev/stderr` device paths.
   */
  private async applyRedirects(redirects: Redirect[]): Promise<() => void> {
    const exp = this.expander();
    const savedStdout = this.stdoutSink;
    const savedStderr = this.stderrSink;
    const savedFds = new Map<number, FdEntry | undefined>();
    const closers: Array<() => void> = [];
    const snapshotFd = (fd: number): void => { if (fd !== 1 && fd !== 2 && !savedFds.has(fd)) savedFds.set(fd, this.fdTable.get(fd)); };

    for (const r of redirects) {
      if (r.op === '<' || r.op === '<<' || r.op === '<<<' || r.op === '<>') continue; // stdin handled per-command

      if (r.op === '>&') {
        // fd-dup: `N>&M` makes fd N write where M writes; `N>&-` closes N.
        const fd = r.fd ?? 1;
        snapshotFd(fd);
        if (r.target === '-') { this.setFdSink(fd, () => { /* closed */ }); if (fd > 2) this.fdTable.delete(fd); continue; }
        const dst = parseInt(r.target, 10);
        if (!Number.isNaN(dst)) this.setFdSink(fd, this.sinkForFd(dst));
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
      const sink = this.makeFileSink(path, append, closers);
      if (r.op === '&>' || r.op === '&>>') { this.stdoutSink = sink; this.stderrSink = sink; }
      else { snapshotFd(fd); this.setFdSink(fd, sink); }
    }

    return () => {
      for (const c of closers) c();
      this.stdoutSink = savedStdout;
      this.stderrSink = savedStderr;
      for (const [fd, prev] of savedFds) { if (prev === undefined) this.fdTable.delete(fd); else this.fdTable.set(fd, prev); }
    };
  }

  /**
   * Install `exec`'s redirects permanently on the per-shell fd table. Output
   * fds (`N>file`/`N>>file`) get a write sink; input fds (`N<file`/`N<>file`)
   * are buffered for `read -u N`; `N>&M` dups; `N>&-` closes. Returns 1 on a
   * missing input file (and writes a diagnostic).
   */
  private async execBuiltinRedirects(redirects: Redirect[]): Promise<number> {
    const exp = this.expander();
    const fs = this.fs;
    for (const r of redirects) {
      const fd = r.fd ?? (r.op === '<' || r.op === '<>' ? 0 : 1);
      if (r.op === '>&') {
        if (r.target === '-') { this.fdTable.delete(fd); continue; }
        const dst = parseInt(r.target, 10);
        if (!Number.isNaN(dst)) this.fdTable.set(fd, { mode: 'write', sink: this.sinkForFd(dst) });
        continue;
      }
      if (r.op === '<' || r.op === '<>') {
        const path = await exp.expandToString(r.target);
        if (!fs) { this.writeStderr(`shell: exec: ${path}: cannot open\n`); return 1; }
        let input = '';
        if (r.op === '<' || path !== '/dev/null') {
          try { input = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true }))); }
          catch {
            if (r.op === '<>') { input = ''; /* <> creates if absent */ }
            else { this.writeStderr(`shell: ${path}: No such file or directory\n`); return 1; }
          }
        }
        const entry: FdEntry = { mode: r.op === '<>' ? 'rw' : 'read', input, pos: 0 };
        if (r.op === '<>') { entry.sink = this.makeFileSink(path, false, []); }
        this.fdTable.set(fd, entry);
        continue;
      }
      // Output: > >> >| (and &> &>> map to fd 1+2)
      const path = await exp.expandToString(r.target);
      const append = r.op === '>>' || r.op === '&>>';
      let seed = '';
      if (append && fs && path !== '/dev/null' && path !== '/dev/stdout' && path !== '/dev/stderr') {
        try { seed = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true }))); } catch { seed = ''; }
      }
      const sink = this.makeExecFileSink(path, seed);
      if (r.op === '&>' || r.op === '&>>') {
        this.fdTable.set(1, { mode: 'write', sink });
        this.fdTable.set(2, { mode: 'write', sink });
      } else {
        this.fdTable.set(fd, { mode: 'write', sink });
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
  private makeExecFileSink(path: string, seed: string): (s: string) => void {
    if (path === '/dev/null') return () => { /* discard */ };
    if (path === '/dev/stdout') return (s) => this.stdoutSink(s);
    if (path === '/dev/stderr') return (s) => this.stderrSink(s);
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

  /** Read one line (default) from a numbered input fd, advancing its cursor. For `read -u N`. */
  readFdLine(fd: number): string | undefined {
    const entry = this.fdTable.get(fd);
    if (!entry || entry.input === undefined) return undefined;
    const pos = entry.pos ?? 0;
    if (pos >= entry.input.length) return undefined; // EOF
    const nl = entry.input.indexOf('\n', pos);
    const end = nl >= 0 ? nl : entry.input.length;
    const line = entry.input.slice(pos, end);
    entry.pos = nl >= 0 ? nl + 1 : entry.input.length;
    return line;
  }

  private makeFileSink(path: string, append: boolean, closers: Array<() => void>): (s: string) => void {
    if (path === '/dev/null') return () => { /* discard */ };
    if (path === '/dev/stdout') return (s) => this.stdoutSink(s);
    if (path === '/dev/stderr') return (s) => this.stderrSink(s);
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

  private async execPipeline(stmt: Statement): Promise<number> {
    const stages = stmt.stages ?? [];
    if (stages.length === 0) return 0;

    if (stmt.background) {
      return this.execBackground(stmt);
    }

    let status: number;
    if (stages.length === 1) {
      status = await this.execSimple(stages[0]);
      this.pipeStatus = [status];
    } else {
      status = await this.execMultiStagePipeline(stages);
    }
    if (stmt.negate) status = status === 0 ? 1 : 0;
    return status;
  }

  private async execMultiStagePipeline(stages: SimpleCommand[]): Promise<number> {
    const expander = this.expander();
    const expanded: Array<{ name: string; argv: string[]; env: Record<string, string> }> = [];
    for (const s of stages) expanded.push(await this.expandCommand(s, expander));

    if (this.options.xtrace) {
      for (const e of expanded) this.writeStderr('+ ' + [e.name, ...e.argv].join(' ') + '\n');
    }

    if (expanded.every((e) => (isBuiltin(e.name) && builtinShadowsExternal(e.name, e.argv)) || this.functions.has(e.name))) {
      let stdin = '';
      let status = 0;
      const codes: number[] = [];
      for (let i = 0; i < expanded.length; i++) {
        const isLast = i === expanded.length - 1;
        const { name, argv } = expanded[i];
        let captured = '';
        const sink = isLast ? (s: string) => this.writeStdout(s) : (s: string) => { captured += s; };
        status = await this.dispatch(name, argv, { stdin, write: sink });
        codes.push(status);
        if (this.exiting !== undefined) { this.pipeStatus = codes; return status; }
        stdin = captured;
      }
      this.pipeStatus = codes;
      return this.pipelineStatus(codes, status);
    }

    // A `<` / `<<` / `<<<` redirect on the FIRST stage becomes that stage's
    // inline stdin (later stages read the previous stage's pipe). Without this a
    // stdin-reading head (`grep foo < file | sort`) would block.
    const headStdin = await this.resolveStdin(stages[0].redirects);

    const stageParams: PipelineStageParams[] = [];
    for (let i = 0; i < expanded.length; i++) {
      const { name, argv, env } = expanded[i];
      const isLast = i === expanded.length - 1;
      const code = this.resolve(name);
      if (code === undefined) { this.writeStderr(`shell: ${name}: command not found\n`); this.pipeStatus = [127]; return 127; }
      stageParams.push({ code, args: [name, ...argv], env: { ...this.context.env, ...env }, cwd: this.context.cwd, captureStdout: isLast, stdinData: i === 0 ? headStdin : undefined });
    }

    if (this.kernel.runPipeline) {
      const result = await this.kernel.runPipeline(stageParams);
      if (result.lastStdout) await this.writeCaptured(result.lastStdout);
      this.pipeStatus = result.exitCodes;
      return this.pipelineStatus(result.exitCodes, result.exitCodes[result.exitCodes.length - 1] ?? 0);
    }

    const handles = await Promise.all(stageParams.map((p) => this.kernel.spawn(toSpawnParams(p))));
    const last = handles[handles.length - 1];
    if (last?.stdout) await this.writeCaptured(last.stdout);
    const waits = await Promise.all(handles.map((h) => this.kernel.wait(h.pid)));
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

  private async execSimple(cmd: SimpleCommand): Promise<number> {
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
      ? new Expander(this.withOverlay(localEnv))
      : expander;

    const { name, argv } = await this.expandCommand(cmd, argExpander);

    if (name === '') {
      if (this.options.xtrace && cmd.assignments.length > 0) {
        this.writeStderr('+ ' + cmd.assignments.map((a) => `${a.name}=${a.value}`).join(' ') + '\n');
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
      return await this.execBuiltinRedirects(cmd.redirects);
    }

    if (this.options.xtrace) {
      this.writeStderr('+ ' + [name, ...argv].join(' ') + '\n');
    }

    // stdin from input redirects
    const stdin = await this.resolveStdin(cmd.redirects);

    // Apply output redirects around the command. A refused redirect (noclobber)
    // aborts the command with status 1 — it never runs.
    let restore: (() => void) | undefined;
    if (cmd.redirects.length) {
      try {
        restore = await this.applyRedirects(cmd.redirects);
      } catch (e) {
        if (e instanceof RedirectError) { this.writeStderr(`shell: ${e.message}\n`); return 1; }
        throw e;
      }
    }
    try {
      if (this.functions.has(name)) {
        return await this.callFunction(name, argv, localEnv);
      }
      if (isBuiltin(name) && builtinShadowsExternal(name, argv)) {
        const saved = { ...this.context.env };
        Object.assign(this.context.env, localEnv);
        const status = await this.dispatch(name, argv, { stdin });
        if (cmd.assignments.length > 0 && name !== 'export' && name !== 'unset' && name !== 'local'
          && name !== 'declare' && name !== 'readonly') {
          for (const k of Object.keys(this.context.env)) if (!(k in saved)) delete this.context.env[k];
          for (const k of Object.keys(saved)) this.context.env[k] = saved[k];
        }
        return status;
      }
      return await this.spawnExternal(name, argv, localEnv, stdin);
    } finally {
      if (restore) restore();
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
    this.context.env[a.name] = a.append ? (this.context.env[a.name] ?? '') + val : val;
  }

  private withOverlay(overlay: Record<string, string>): ShellEnv {
    const env = { ...this.context.env, ...overlay };
    return {
      get: (n) => env[n],
      set: (n, v) => { env[n] = v; this.context.env[n] = v; },
      has: (n) => n in env,
      getSpecial: (n) => this.getSpecial(n),
      getPositional: () => this.getPositional(),
      runCommandSub: (s) => this.runCommandSub(s),
      listDir: (p) => this.listDir(p),
      statPath: (p) => this.statPath(p),
      cwd: this.context.cwd,
      nounset: () => this.nounset(),
      getArray: (n) => this.arrays.get(n),
      posix: () => this.posix(),
      shopt: (n) => this.shopt(n),
    };
  }

  private async spawnExternal(name: string, argv: string[], localEnv: Record<string, string>, stdin?: string): Promise<number> {
    const code = this.resolve(name);
    if (code === undefined) {
      this.writeStderr(`shell: ${name}: command not found\n`);
      return 127;
    }
    const params: SpawnParams = {
      code, args: [name, ...argv],
      env: { ...this.context.env, ...localEnv },
      cwd: this.context.cwd,
      captureStdout: true,
      stdinData: stdin,
    };
    const handle = await this.kernel.spawn(params);
    if (handle.stdout) await this.writeCaptured(handle.stdout);
    const { code: status } = await this.kernel.wait(handle.pid);
    return status;
  }

  private async callFunction(name: string, argv: string[], localEnv: Record<string, string>): Promise<number> {
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
      status = await this.execList(fn.body);
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

  private async execBackground(stmt: Statement): Promise<number> {
    const id = this.nextJobId++;
    const cmdStr = describeStages(stmt.stages ?? []);
    const job: Job = { id, pids: [], command: cmdStr, state: 'running' };
    this.jobs.push(job);
    // Run the pipeline detached. We DON'T await it (background semantics), but
    // record completion on the job. A synthetic pid models the job leader.
    const pid = 100000 + id;
    job.pids = [pid];
    this.lastBgPid = pid;
    const bg = { ...stmt, background: false };
    const promise = this.execStatement(bg).then((code) => {
      job.state = 'done';
      job.exitCode = code;
      return code;
    }).catch(() => { job.state = 'done'; job.exitCode = 1; return 1; });
    (job as Job & { promise?: Promise<number> }).promise = promise;
    return 0;
  }

  private async waitForJob(spec?: number): Promise<number> {
    if (spec === undefined) return this.waitAllJobs();
    // spec may be a pid or %jobid; find the matching job
    const job = this.jobs.find((j) => j.pids.includes(spec) || j.id === spec);
    if (!job) return 0;
    const p = (job as Job & { promise?: Promise<number> }).promise;
    if (p) return (await p) ?? 0;
    return job.exitCode ?? 0;
  }

  private async waitAllJobs(): Promise<number> {
    let last = 0;
    for (const job of this.jobs) {
      const p = (job as Job & { promise?: Promise<number> }).promise;
      if (p) last = (await p) ?? 0;
    }
    return last;
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

  /** Dispatch a builtin (with loop/return control surfaced as exceptions). */
  private async dispatch(name: string, argv: string[], io: { stdin?: string; write?: (s: string) => void } = {}): Promise<number> {
    const ctx: BuiltinContext = {
      cwd: this.context.cwd,
      env: this.context.env,
      write: io.write ?? ((s) => this.writeStdout(s)),
      writeErr: (s) => this.writeStderr(s),
      stdin: io.stdin,
      lastStatus: this.lastStatus,
      exit: (code) => { this.exiting = code; },
      eval: (src) => this.run(this.parseSrc(src), true),
      sourceFile: (args) => this.sourceFile(args),
      readFdLine: (fd) => this.readFdLine(fd),
      doBreak: (n) => { throw new LoopBreak(n); },
      doContinue: (n) => { throw new LoopContinue(n); },
      doReturn: (n) => { throw new FuncReturn(n); },
      state: this.shellState(),
    };
    const status = await runBuiltin(name, argv, ctx);
    this.context.cwd = ctx.cwd;
    return status;
  }

  private async writeCaptured(bytes: Promise<Uint8Array>): Promise<void> {
    const out = await bytes;
    if (out.byteLength > 0) this.writeStdout(new TextDecoder().decode(out));
  }

  protected writeStdout(s: string): void { this.stdoutSink(s); }
  protected writeStderr(s: string): void { this.stderrSink(s); }
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
  return { code: p.code, args: p.args, env: p.env, cwd: p.cwd, captureStdout: p.captureStdout, captureStderr: p.captureStderr, stdinData: p.stdinData };
}

function describeStages(stages: SimpleCommand[]): string {
  return stages.map((s) => [s.name, ...s.args].filter((w) => w !== '').join(' ')).join(' | ');
}

/** Reconstruct a readable command string for the history list. */
function describeStatement(stmt: Statement): string {
  if (stmt.type === 'Pipeline') return describeStages(stmt.stages ?? []);
  return stmt.type.toLowerCase();
}

/** Match a shell case/`[[ ]]` glob pattern against a string. */
function matchCasePattern(value: string, pattern: string): boolean {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') { re += escapeRe(pattern[i + 1] ?? ''); i += 2; continue; }
    if (c === '*') { re += '.*'; i++; continue; }
    if (c === '?') { re += '.'; i++; continue; }
    if (c === '[') {
      let j = i + 1; let neg = false;
      if (pattern[j] === '!' || pattern[j] === '^') { neg = true; j++; }
      let cls = '';
      while (j < pattern.length && pattern[j] !== ']') { cls += pattern[j]; j++; }
      if (j < pattern.length) { re += '[' + (neg ? '^' : '') + cls + ']'; i = j + 1; continue; }
      re += '\\['; i++; continue;
    }
    re += escapeRe(c); i++;
  }
  try { return new RegExp('^' + re + '$').test(value); } catch { return value === pattern; }
}

function escapeRe(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
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
