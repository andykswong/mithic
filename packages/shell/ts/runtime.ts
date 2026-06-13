import type { Process, ProcessManager } from '@mithic/process/types';

export interface RuntimeConfig {
  manager: ProcessManager & Partial<Disposable>;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExecOptions {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class Runtime implements Disposable {
  readonly #manager: ProcessManager & Partial<Disposable>;
  readonly #env: Record<string, string>;
  readonly #cwd: string;

  constructor(config: RuntimeConfig) {
    this.#manager = config.manager;
    this.#env = config.env ?? {};
    this.#cwd = config.cwd ?? '/';
  }

  exec(command: string, options?: ExecOptions): Process {
    const args = options?.args ?? [];
    const cwd = options?.cwd ?? this.#cwd;
    return this.#manager.spawn(command, args, {
      env: { ...this.#env, ...options?.env, PWD: cwd },
      cwd,
    });
  }

  waitAsync(proc: Process): Promise<number> {
    return proc.waitAsync();
  }

  [Symbol.dispose](): void {
    this.#manager[Symbol.dispose]?.();
  }
}
