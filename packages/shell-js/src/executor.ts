import type { Program, SimpleCommand, Statement } from './ast.ts';
import { parse } from './parser.ts';
import { Expander } from './expander.ts';
import { isBuiltin, runBuiltin } from './builtins.ts';
import type { BuiltinContext } from './builtins.ts';
import type {
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
  private lastStatus = 0;
  private exiting: number | undefined;

  constructor(kernel: KernelClient, context: ShellContext, options: ExecutorOptions = {}) {
    this.kernel = kernel;
    this.context = context;
    // Default resolver treats the command name as its own spawnable path — the
    // kernel/launcher performs the real lookup. A custom resolver (e.g. the E2E
    // resolver mapping names to inline guest source) overrides this.
    this.resolve = options.resolve ?? ((name) => name);
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

    // Multi-stage pipeline. If any stage is a builtin, run the WHOLE pipeline by
    // spawning each stage (builtins that need spawning are resolved to inline
    // guest programs by the resolver) — keeping the "one child per stage"
    // contract. The real kernel exposes runPipeline for zero-hop wiring; a mock
    // without runPipeline triggers the per-stage spawn fallback.
    const expander = new Expander(this.context.env);
    const stageParams: PipelineStageParams[] = [];
    for (const stage of stages) {
      const { name, argv, env } = this.expandCommand(stage, expander);
      const code = this.resolve(name);
      if (code === undefined) {
        // Unknown command in a pipeline stage: report and fail the pipeline.
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
    const expander = new Expander(this.context.env);

    // Apply assignments. With no command word, they mutate the shell env; with a
    // command word, they apply to that command's environment only.
    const localEnv: Record<string, string> = {};
    for (const a of cmd.assignments) {
      localEnv[a.name] = expander.expandToString(a.value);
    }

    const { name, argv } = this.expandCommand(cmd, expander);

    if (name === '') {
      // Pure assignment: persist into the shell env.
      Object.assign(this.context.env, localEnv);
      return 0;
    }

    if (isBuiltin(name)) {
      // Builtins see the assignments merged into the live env for the call.
      const saved = { ...this.context.env };
      Object.assign(this.context.env, localEnv);
      const status = await this.runBuiltinCommand(name, argv);
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
      return status;
    }

    // External command: resolve to guest code and spawn.
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

  private async runBuiltinCommand(name: string, argv: string[]): Promise<number> {
    const ctx: BuiltinContext = {
      cwd: this.context.cwd,
      env: this.context.env,
      write: (s) => this.writeStdout(s),
      writeErr: (s) => this.writeStderr(s),
      lastStatus: this.lastStatus,
      exit: (code) => { this.exiting = code; },
      eval: (src) => this.run(parse(src)),
    };
    const status = await runBuiltin(name, argv, ctx);
    // Reflect any cwd change the builtin made back onto the shell context.
    this.context.cwd = ctx.cwd;
    return status;
  }

  /** Default stdout sink: the host process stdout. Overridden by process entry. */
  protected writeStdout(s: string): void {
    if (typeof process !== 'undefined' && process.stdout) {
      process.stdout.write(s);
    }
  }

  protected writeStderr(s: string): void {
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(s);
    }
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
