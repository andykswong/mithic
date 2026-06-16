/**
 * `@mithic/shell-js` — a POSIX-style shell interpreter that runs as a regular
 * Isola process.
 *
 * Public surface:
 *   - the lexer / parser / expander / builtins / executor building blocks, and
 *   - {@link runScript}, an E2E helper that boots a real kernel + runtime and
 *     runs a script string end-to-end, returning its captured stdout + exit code.
 */
export { tokenize } from './lexer.ts';
export type { Token, TokenType } from './lexer.ts';
export { parse } from './parser.ts';
export type {
  Program,
  Statement,
  SimpleCommand,
  Redirect,
  RedirectOp,
  Assignment,
} from './ast.ts';
export { Expander } from './expander.ts';
export { BUILTINS, isBuiltin, runBuiltin } from './builtins.ts';
export type { BuiltinContext } from './builtins.ts';
export { Executor } from './executor.ts';
export type { ShellContext, ExecutorOptions, CommandResolver } from './executor.ts';
export type {
  KernelClient,
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
 * Boot a real {@link Kernel} over a {@link WorkerRuntime} and run a shell script
 * end-to-end, returning the shell's captured stdout and exit code.
 *
 * The shell guest is the built `dist/process.js` module (referenced by URL so
 * the kernel's launcher imports it with normal ESM resolution). In a Node/vitest
 * environment `Worker` is undefined, so the kernel's in-process launcher runs the
 * guest on the same thread — which is fine: the shell's interpreter logic is what
 * this exercises. The script is passed as a guest argument.
 */
export async function runScript(src: string): Promise<RunScriptResult> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs });

  // The built guest entry. Resolves to packages/shell-js/dist/process.js whether
  // this module runs from src (vitest) or dist (published).
  const guestUrl = new URL('../dist/process.js', import.meta.url);

  const { pid, stdout } = await kernel.spawn(guestUrl, {
    args: ['shell', src],
    captureStdout: true,
  });
  const { code } = await kernel.wait(pid);
  const bytes = stdout ? await stdout : new Uint8Array();
  return { stdout: new TextDecoder().decode(bytes), code };
}
