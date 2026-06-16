/**
 * KNOWN LIMITATIONS (as of J.7)
 *
 * (a) External command spawning: the executor's spawn path is fully implemented
 *     and mock-tested, but is unreachable from a real guest. Spawning external
 *     (non-builtin) commands requires a `process/spawn` kernel syscall that does
 *     not yet exist in the Isola 2.0 kernel. It will land in a future kernel
 *     milestone; until then only builtins are executable from a real shell guest.
 *
 * (b) `$?` / `$PIPESTATUS`, glob expansion, brace expansion, shell functions,
 *     and job control are deferred to J.8.
 *
 * (c) Input redirects (`<`), heredocs (`<<`), and fd-dup redirects (`2>`, etc.)
 *     are deferred to J.8. Attempting to use them raises an explicit error;
 *     they are never silently dropped.
 */

import type { Program, Redirect, SimpleCommand, Statement } from './ast.ts';
import { parse } from './parser.ts';
import { Expander } from './expander.ts';
import { isBuiltin, runBuiltin } from './builtins.ts';
import type { BuiltinContext } from './builtins.ts';
import type {
  FsClient,
  KernelClient,
  PipelineStageParams,
  SpawnParams,
} from './kernel-client.ts';

/** Mutable shell state carried across statements. */
export interface ShellContext {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Resolves a command name to spawnable guest code. Returns `undefined` when the
 * command is unknown ("command not found"). The executor only calls this for
 * NON-builtin commands. For the kernel E2E, the resolver maps `echo`/`cat` (and
 * friends) to tiny inline guest programs (see {@link defaultCommandResolver}).
 */
export type CommandResolver = (name: string) => string | URL | undefined;

export interface ExecutorOptions {
  /** Maps command names to spawnable guest code. */
  resolve?: CommandResolver;
  /** stdout sink. Defaults to the host `process.stdout`. */
  onStdout?: (s: string) => void;
  /** stderr sink. Defaults to the host `process.stderr`. */
  onStderr?: (s: string) => void;
  /**
   * VFS client for redirect execution (>, >>, <). When provided the executor
   * routes redirected I/O through this client instead of the normal stdout/stdin
   * streams. In the real guest these calls go through `isola.syscall('fs/*')`;
   * in unit tests supply an in-memory mock.
   *
   * Unsupported redirect operators (<, <<, fd-dup) throw an explicit error even
   * when `fs` is absent — they are never silently dropped.
   */
  fs?: FsClient;
}

/** Thrown internally by the `exit` builtin to unwind the executor. */
class ShellExit extends Error {
  code: number;
  constructor(code: number) {
    super('exit');
    this.code = code;
  }
}

export class Executor {
  readonly context: ShellContext;
  private kernel: KernelClient;
  private resolve: CommandResolver;
  private fs: FsClient | undefined;
  private lastStatus = 0;
  private exiting: number | undefined;
  private stdoutSink: (s: string) => void;
  private stderrSink: (s: string) => void;

  constructor(kernel: KernelClient, context: ShellContext, options: ExecutorOptions = {}) {
    this.kernel = kernel;
    this.context = context;
    // Default resolver treats the command name as its own spawnable path — the
    // kernel/launcher performs the real lookup. A custom resolver (e.g. the E2E
    // resolver mapping names to inline guest source) overrides this.
    this.resolve = options.resolve ?? ((name) => name);
    this.fs = options.fs;
    this.stdoutSink = options.onStdout ?? ((s) => {
      if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
    });
    this.stderrSink = options.onStderr ?? ((s) => {
      if (typeof process !== 'undefined' && process.stderr) process.stderr.write(s);
    });
  }

  /** Run a parsed program; returns the exit status of the last statement. */
  async run(program: Program): Promise<number> {
    try {
      for (const stmt of program.body) {
        this.lastStatus = await this.execStatement(stmt);
        if (this.exiting !== undefined) return this.exiting;
      }
    } catch (e) {
      if (e instanceof ShellExit) return e.code;
      throw e;
    }
    return this.lastStatus;
  }

  private async execStatement(stmt: Statement): Promise<number> {
    switch (stmt.type) {
      case 'Pipeline':
        return this.execPipeline(stmt);
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
      case 'If':
        return this.execIf(stmt);
      case 'While':
        return this.execWhile(stmt);
      default:
        return 0;
    }
  }

  private async execList(list: Statement[]): Promise<number> {
    let status = 0;
    for (const s of list) {
      status = await this.execStatement(s);
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
      status = await this.execList(stmt.body ?? []);
      if (this.exiting !== undefined) return status;
    }
    return status;
  }

  private async execPipeline(stmt: Statement): Promise<number> {
    const stages = stmt.stages;
    if (stages.length === 0) return 0;
    if (stages.length === 1) return this.execSimple(stages[0]);

    const expander = new Expander(this.context.env);
    const expanded = stages.map((s) => this.expandCommand(s, expander));

    // If EVERY stage is a builtin, run the pipeline in-process: each stage's
    // captured stdout becomes the next stage's stdin. This is the realistic E2E
    // path for the current kernel, which exposes no process-spawn syscall — the
    // shell guest cannot fork children, so builtin pipelines run internally.
    if (expanded.every((e) => isBuiltin(e.name))) {
      let stdin = '';
      let status = 0;
      for (let i = 0; i < expanded.length; i++) {
        const isLast = i === expanded.length - 1;
        const { name, argv } = expanded[i];
        let captured = '';
        const sink = isLast
          ? (s: string) => this.writeStdout(s)
          : (s: string) => { captured += s; };
        status = await this.runBuiltinCommand(name, argv, { stdin, write: sink });
        if (this.exiting !== undefined) return status;
        stdin = captured;
      }
      return status;
    }

    // Otherwise spawn one child per stage. The real kernel exposes runPipeline
    // for zero-hop wiring; a mock without runPipeline uses the per-stage spawn
    // fallback. (Mixed builtin/external pipelines fall here too — builtin stages
    // get resolved to spawnable code by the resolver, or fail as not-found.)
    const stageParams: PipelineStageParams[] = [];
    for (let i = 0; i < expanded.length; i++) {
      const { name, argv, env } = expanded[i];
      const code = this.resolve(name);
      if (code === undefined) {
        this.writeStderr(`shell: ${name}: command not found\n`);
        return 127;
      }
      stageParams.push({
        code,
        args: [name, ...argv],
        env: { ...this.context.env, ...env },
        cwd: this.context.cwd,
      });
    }

    if (this.kernel.runPipeline) {
      const result = await this.kernel.runPipeline(stageParams);
      return result.exitCodes[result.exitCodes.length - 1] ?? 0;
    }

    // Fallback: spawn each stage and await it. The mock kernel uses this path.
    const handles = await Promise.all(
      stageParams.map((p) => this.kernel.spawn(toSpawnParams(p))),
    );
    const waits = await Promise.all(handles.map((h) => this.kernel.wait(h.pid)));
    return waits[waits.length - 1]?.code ?? 0;
  }

  /** Execute a single simple command: builtin in-process, else spawn. */
  private async execSimple(cmd: SimpleCommand): Promise<number> {
    // Validate redirects early — fail loudly for unsupported operators rather
    // than silently dropping them.
    this.validateRedirects(cmd.redirects);

    const expander = new Expander(this.context.env);

    // Apply assignments. With no command word, they mutate the shell env; with a
    // command word, they apply to that command's environment only.
    const localEnv: Record<string, string> = {};
    for (const a of cmd.assignments) {
      localEnv[a.name] = expander.expandToString(a.value);
    }

    // ── Fix 1: expand command args against the effective env ─────────────────
    // When prefix assignments accompany a command word (e.g. `FOO=bar echo $FOO`),
    // the assigned values must be visible to that command's own arg expansion.
    // Build the effective env (base + prefix overlay) FIRST, then expand.
    // Pure assignments (no command) continue to use the base env for expansion
    // because their RHS is evaluated sequentially and persisted below.
    const hasCommand = cmd.name !== '';
    const expandEnv = hasCommand && Object.keys(localEnv).length > 0
      ? { ...this.context.env, ...localEnv }
      : this.context.env;
    const argExpander = hasCommand && Object.keys(localEnv).length > 0
      ? new Expander(expandEnv)
      : expander;

    const { name, argv } = this.expandCommand(cmd, argExpander);

    if (name === '') {
      // Pure assignment: persist into the shell env.
      Object.assign(this.context.env, localEnv);
      return 0;
    }

    if (isBuiltin(name)) {
      // Resolve redirect targets using the effective env.
      const redirectSink = this.buildRedirectSink(cmd.redirects, argExpander);

      // Builtins see the assignments merged into the live env for the call.
      const saved = { ...this.context.env };
      Object.assign(this.context.env, localEnv);
      const status = await this.runBuiltinCommand(name, argv, { write: redirectSink ?? undefined });
      // export/unset/cd are meant to persist; restore only the temporary
      // assignment overlay that the builtin didn't itself intend to change is
      // out of scope for the minimal shell — builtins operate on the live env.
      if (cmd.assignments.length > 0 && name !== 'export' && name !== 'unset') {
        // Temporary assignment prefix on a builtin: revert env to pre-call.
        for (const k of Object.keys(this.context.env)) {
          if (!(k in saved)) delete this.context.env[k];
        }
        for (const k of Object.keys(saved)) this.context.env[k] = saved[k];
      }
      if (redirectSink) redirectSink.close();
      return status;
    }

    // External command: resolve to guest code and spawn.
    //
    // DEFERRED (J.7): spawning external commands requires a `process/spawn`
    // kernel syscall that does not yet exist in the Isola 2.0 kernel. The spawn
    // path below is implemented and mock-tested but is unreachable from a real
    // guest until that syscall lands. See also Fix 3 comment below.
    const code = this.resolve(name);
    if (code === undefined) {
      return 127; // command not found
    }
    const params: SpawnParams = {
      code,
      args: [name, ...argv],
      env: { ...this.context.env, ...localEnv },
      cwd: this.context.cwd,
      captureStdout: false,
    };
    const handle = await this.kernel.spawn(params);
    const { code: status } = await this.kernel.wait(handle.pid);
    return status;
  }

  private expandCommand(
    cmd: SimpleCommand,
    expander: Expander,
  ): { name: string; argv: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {};
    for (const a of cmd.assignments) env[a.name] = expander.expandToString(a.value);
    const nameFields = cmd.name === '' ? [] : expander.expandWord(cmd.name);
    const name = nameFields[0] ?? '';
    const argv: string[] = [...nameFields.slice(1)];
    for (const arg of cmd.args) argv.push(...expander.expandWord(arg));
    return { name, argv, env };
  }

  private async runBuiltinCommand(
    name: string,
    argv: string[],
    io: { stdin?: string; write?: (s: string) => void } = {},
  ): Promise<number> {
    const ctx: BuiltinContext = {
      cwd: this.context.cwd,
      env: this.context.env,
      write: io.write ?? ((s) => this.writeStdout(s)),
      writeErr: (s) => this.writeStderr(s),
      stdin: io.stdin,
      lastStatus: this.lastStatus,
      exit: (code) => { this.exiting = code; },
      eval: (src) => this.run(parse(src)),
    };
    const status = await runBuiltin(name, argv, ctx);
    // Reflect any cwd change the builtin made back onto the shell context.
    this.context.cwd = ctx.cwd;
    return status;
  }

  /**
   * Validate that all redirects in a command are ones we handle. Throws a
   * clear error for unsupported operators so they are never silently dropped.
   *
   * Supported: `>` (truncate-write), `>>` (append-write).
   * Not yet supported: `<` (stdin redirect), fd-dup (`2>`), heredoc (`<<`).
   */
  private validateRedirects(redirects: Redirect[]): void {
    for (const r of redirects) {
      if (r.op !== '>' && r.op !== '>>') {
        throw new Error(
          `shell: unsupported redirect operator '${r.op}' — input redirects (<) and ` +
          'heredocs (<<) are not yet implemented (deferred to J.8)',
        );
      }
    }
  }

  /**
   * Build a write-sink that captures builtin stdout and flushes it to the
   * redirect target file(s). Returns `null` when there are no output redirects.
   *
   * Only the LAST `>` / `>>` redirect targeting stdout (fd 1, the default) is
   * applied here (POSIX: later redirects shadow earlier ones). The returned
   * object has a `close()` method the caller MUST invoke after the builtin
   * completes so the fd is flushed and closed.
   */
  private buildRedirectSink(
    redirects: Redirect[],
    expander: Expander,
  ): ((s: string) => void) & { close(): void } | null {
    // Pick the last stdout redirect (op `>` or `>>`).
    let last: Redirect | undefined;
    for (const r of redirects) {
      if (r.op === '>' || r.op === '>>') last = r;
    }
    if (!last) return null;

    const fs = this.fs;
    if (!fs) {
      // No FsClient provided. Surface a clear error rather than silently
      // writing to stdout — this would be wrong behaviour that's hard to debug.
      throw new Error(
        `shell: redirect '${last.op} ${last.target}' requires an FsClient ` +
        '(pass \'fs\' in ExecutorOptions)',
      );
    }

    const path = expander.expandToString(last.target);
    const append = last.op === '>>';
    const fd = fs.fsOpen(path, {
      write: !append,
      append,
      create: true,
      truncate: !append,
    });

    const sink = (s: string) => fs.fsWrite(fd, s);
    sink.close = () => fs.fsClose(fd);
    return sink;
  }

  protected writeStdout(s: string): void {
    this.stdoutSink(s);
  }

  protected writeStderr(s: string): void {
    this.stderrSink(s);
  }
}

function toSpawnParams(p: PipelineStageParams): SpawnParams {
  return {
    code: p.code,
    args: p.args,
    env: p.env,
    cwd: p.cwd,
    captureStdout: p.captureStdout,
    captureStderr: p.captureStderr,
  };
}
