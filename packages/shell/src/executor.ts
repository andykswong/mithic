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
import { Expander } from './expander.ts';
import type { ShellEnv } from './expander.ts';
import { isBuiltin, runBuiltin } from './builtins.ts';
import type { BuiltinContext, ShellState } from './builtins.ts';
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

export class Executor implements ShellEnv {
  readonly context: ShellContext;
  private kernel: KernelClient;
  private resolve: CommandResolver;
  private fs: FsClient | undefined;
  private lastStatus = 0;
  private pipeStatus: number[] = [];
  private lastBgPid = 0;
  private exiting: number | undefined;
  private stdoutSink: (s: string) => void;
  private stderrSink: (s: string) => void;
  private functions = new Map<string, ShellFunction>();
  private localScopes: Array<Set<string>> = [];
  private localSaved: Array<Map<string, string | undefined>> = [];
  private jobs: Job[] = [];
  private nextJobId = 1;
  private errExit = false;

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
  get cwd(): string { return this.context.cwd; }

  getSpecial(name: string): string | undefined {
    switch (name) {
      case '?': return String(this.lastStatus);
      case '#': return String((this.context.positional ?? []).length);
      case '$': return String(this.context.pid ?? 0);
      case '!': return String(this.lastBgPid);
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

  async runCommandSub(src: string): Promise<string> {
    let out = '';
    const savedStdout = this.stdoutSink;
    this.stdoutSink = (s) => { out += s; };
    try {
      await this.run(parse(src), /*nested*/ true);
    } finally {
      this.stdoutSink = savedStdout;
    }
    return out;
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
      setErrExit: (v) => { this.errExit = v; },
    };
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
        this.lastStatus = await this.execStatement(stmt);
        if (this.exiting !== undefined) return this.exiting;
        if (this.errExit && this.lastStatus !== 0 && !nested) {
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

  private async execSubshell(stmt: Statement): Promise<number> {
    // Subshell: isolate env/cwd mutations by snapshotting and restoring.
    const savedEnv = { ...this.context.env };
    const savedCwd = this.context.cwd;
    try {
      return await this.execList(stmt.body ?? []);
    } finally {
      this.context.env = savedEnv;
      this.context.cwd = savedCwd;
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
    const restore = await this.applyRedirects(redirects);
    try { return await fn(); } finally { restore(); }
  }

  /**
   * Apply a set of redirects by swapping the stdout/stderr sinks (and recording
   * a here-doc/file stdin). Returns a restore function. Supports `>` `>>` `<`
   * `<<` `<<<` `2>` `&>` `2>&1`, and `/dev/null`.
   */
  private async applyRedirects(redirects: Redirect[]): Promise<() => void> {
    const exp = this.expander();
    const savedStdout = this.stdoutSink;
    const savedStderr = this.stderrSink;
    const closers: Array<() => void> = [];

    for (const r of redirects) {
      if (r.op === '<' || r.op === '<<' || r.op === '<<<') continue; // stdin handled per-command
      const fd = r.fd ?? (r.op === '&>' ? 1 : (r.op === '>&' ? 1 : 1));

      if (r.op === '>&') {
        // fd-dup: e.g. 2>&1 — make `fd` write to wherever the target fd writes now.
        const dst = r.target;
        if (dst === '1') { const cur = this.stdoutSink; if (fd === 2) this.stderrSink = (s) => cur(s); }
        else if (dst === '2') { const cur = this.stderrSink; if (fd === 1) this.stdoutSink = (s) => cur(s); }
        continue;
      }

      const path = await exp.expandToString(r.target);
      const append = r.op === '>>';
      const sink = this.makeFileSink(path, append, closers);
      if (r.op === '&>') { this.stdoutSink = sink; this.stderrSink = sink; }
      else if (fd === 2) this.stderrSink = sink;
      else this.stdoutSink = sink;
    }

    return () => {
      for (const c of closers) c();
      this.stdoutSink = savedStdout;
      this.stderrSink = savedStderr;
    };
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
      } else if (r.op === '<') {
        const path = await exp.expandToString(r.target);
        if (path === '/dev/null') { stdin = ''; continue; }
        const fs = this.fs;
        if (!fs) throw new Error(`shell: input redirect from '${path}' requires an FsClient`);
        stdin = await Promise.resolve(fs.fsRead(fs.fsOpen(path, { read: true })));
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
      return status;
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
      return result.exitCodes[result.exitCodes.length - 1] ?? 0;
    }

    const handles = await Promise.all(stageParams.map((p) => this.kernel.spawn(toSpawnParams(p))));
    const last = handles[handles.length - 1];
    if (last?.stdout) await this.writeCaptured(last.stdout);
    const waits = await Promise.all(handles.map((h) => this.kernel.wait(h.pid)));
    this.pipeStatus = waits.map((w) => w.code);
    return waits[waits.length - 1]?.code ?? 0;
  }

  private async execSimple(cmd: SimpleCommand): Promise<number> {
    const expander = this.expander();

    const localEnv: Record<string, string> = {};
    for (const a of cmd.assignments) localEnv[a.name] = await expander.expandToString(a.value);

    const hasCommand = cmd.name !== '';
    const argExpander = hasCommand && Object.keys(localEnv).length > 0
      ? new Expander(this.withOverlay(localEnv))
      : expander;

    const { name, argv } = await this.expandCommand(cmd, argExpander);

    if (name === '') {
      for (const k of Object.keys(localEnv)) {
        this.declareLocal(k);
        this.context.env[k] = localEnv[k];
      }
      return 0;
    }

    // stdin from input redirects
    const stdin = await this.resolveStdin(cmd.redirects);

    // Apply output redirects around the command.
    const restore = cmd.redirects.length ? await this.applyRedirects(cmd.redirects) : undefined;
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
    for (const a of cmd.assignments) env[a.name] = await expander.expandToString(a.value);
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
      eval: (src) => this.run(parse(src), true),
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
  return stages.map((s) => [s.name, ...s.args].join(' ')).join(' | ');
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
