import { Bash, getCommandNames, type BashOptions, type ExecOptions as JustBashExecOptions } from 'just-bash';
import type { ProcessManager, ExecResult } from '@mithic/process/types';
import type { FileSystemRouter } from '@mithic/io/vfs';
import { VirtualFileSystem } from './adapter.ts';
import { createProcessCommands } from './commands.ts';
import { createExecFallbackPlugin } from './transform.ts';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
}

export interface JustBashShellConfig {
  processManager: ProcessManager;
  vfsRouter: FileSystemRouter;
  cwd?: string;
  env?: Record<string, string>;
  bashOptions?: Partial<BashOptions>;
}

export class JustBashShell {
  readonly manager: ProcessManager;
  readonly #bash: Bash;
  readonly #vfs: VirtualFileSystem;
  #cwd: string;
  #env: Record<string, string>;

  constructor(config: JustBashShellConfig) {
    this.manager = config.processManager;
    this.#cwd = config.cwd ?? '/';
    this.#env = config.env ?? {};
    this.#vfs = new VirtualFileSystem(config.vfsRouter, this.#cwd);

    const processCommands = createProcessCommands(this.manager);
    const customCommands = [
      ...(config.bashOptions?.customCommands ?? []),
      ...processCommands,
    ];

    this.#bash = new Bash({
      ...config.bashOptions,
      fs: this.#vfs,
      env: this.#env,
      cwd: this.#cwd,
      customCommands,
    });

    const knownCommands = new Set([
      ...getCommandNames(),
      ...customCommands.map(c => c.name),
    ]);
    this.#bash.registerTransformPlugin(createExecFallbackPlugin({ knownCommands }));
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const execOpts: JustBashExecOptions = {};

    if (options?.cwd) {
      execOpts.cwd = options.cwd;
    }
    if (options?.env) {
      execOpts.env = options.env;
    }
    if (options?.stdin) {
      execOpts.stdin = new TextDecoder().decode(options.stdin);
    }

    const result = await this.#bash.exec(command, execOpts);

    const encoder = new TextEncoder();
    return {
      stdout: encoder.encode(result.stdout),
      stderr: encoder.encode(result.stderr),
      exitCode: result.exitCode,
    };
  }

  setCwd(path: string): void {
    this.#cwd = path;
    this.#vfs.cwd = path;
  }

  getCwd(): string {
    return this.#cwd;
  }

  setEnv(env: Record<string, string>): void {
    this.#env = env;
  }

  getEnv(): Record<string, string> {
    return { ...this.#env };
  }
}
