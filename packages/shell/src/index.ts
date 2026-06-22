/**
 * `@mithic/shell` — a POSIX-style shell interpreter that runs as a regular
 * Mithic process.
 *
 * Public surface:
 *   - the lexer / parser / expander / builtins / executor building blocks, and
 *   - {@link runScript}, an E2E helper that boots a real kernel + runtime and
 *     runs a script string end-to-end, returning its captured stdout + exit code.
 */
export { tokenize } from './lexer.ts';
export type { Token, TokenType } from './lexer.ts';
export { parse } from './parser.ts';
export type { ParseOptions } from './parser.ts';
export type {
  Program,
  Statement,
  SimpleCommand,
  Redirect,
  RedirectOp,
  Assignment,
} from './ast.ts';
export { Expander } from './expander.ts';
export { BUILTINS, isBuiltin, runBuiltin, SET_O_OPTIONS, SHOPT_NAMES } from './builtins.ts';
export type { BuiltinContext, ShellOptionName } from './builtins.ts';
export { parseCliArgs, VERSION, HELP } from './cli.ts';
export type { CliResult } from './cli.ts';
export { Executor } from './executor.ts';
export type { ShellContext, ExecutorOptions, CommandResolver } from './executor.ts';
export { expandPrompt } from './prompt.ts';
export type { PromptContext } from './prompt.ts';
export type {
  KernelClient,
  FsClient,
  SpawnParams,
  SpawnHandle,
  PipelineStageParams,
  PipelineRunResult,
  WaitOutcome,
} from './kernel-client.ts';

export interface RunScriptResult {
  stdout: string;
  code: number;
}

/**
 * Options for {@link runScript}. `commands` registers inline guest programs the
 * shell can spawn by name as external (non-builtin) commands — the kernel's
 * command resolver maps each name to the supplied spawnable code.
 */
export interface RunScriptOptions {
  /** Map of external command name → spawnable guest code (inline ESM source or URL). */
  commands?: Record<string, string | URL>;
}

/**
 * Boot a real {@link Kernel} over a {@link WorkerRuntime} and run a shell script
 * end-to-end, returning the shell's captured stdout and exit code.
 *
 * The shell guest is the built `dist/process.js` module (referenced by URL so
 * the kernel's launcher imports it with normal ESM resolution). In a Node/vitest
 * environment `Worker` is undefined, so the kernel's in-process launcher runs the
 * guest on the same thread — which is fine: the shell's interpreter logic is what
 * this exercises. The script is passed as a guest argument.
 *
 * The shell is granted a `process` capability so it can fork children; external
 * commands registered via `options.commands` are resolved by the kernel's
 * command resolver and spawned through the `process/spawn` / `process/pipeline`
 * syscalls.
 */
export async function runScript(src: string, options: RunScriptOptions = {}): Promise<RunScriptResult> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const commands = options.commands ?? {};
  const kernel = new Kernel({
    runtime: new WorkerRuntime(),
    vfs,
    // The kernel OWNS what external commands exist: it resolves a bare name to
    // the registered inline guest code, or returns undefined → ENOENT.
    resolveCommand: (name) => commands[name],
  });

  // The built guest entry. Resolves to packages/shell/dist/process.js whether
  // this module runs from src (vitest) or dist (published).
  const guestUrl = new URL('../dist/process.js', import.meta.url);

  const { pid, stdout } = await kernel.spawn(guestUrl, {
    // `-c SRC` runs the script string via the CLI front-end. argv0 is `bash`
    // (not `sh`) so POSIX mode is not auto-enabled for the E2E helper.
    args: ['bash', '-c', src],
    capabilities: [{ type: 'process' }],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  const bytes = stdout ? await stdout : new Uint8Array();
  return { stdout: new TextDecoder().decode(bytes), code };
}
