import { WASIShim, type WASIShimConfig } from '@mithic/wasip2';
import { WASIProcess, type WASIProcessConfig } from '@mithic/process/instantiation';
import type { ProcessManager, Signal, SpawnOptions } from '@mithic/process/types';
import { Process } from '@mithic/process/types';

export interface ShellComponent {
  instantiate(
    compileCore: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, object>,
  ): Promise<{ run: { run: () => number } }>;
  modules: Record<string, string>;
}

export interface MithicShellConfig {
  wasi?: WASIShimConfig;
  process?: WASIProcessConfig;
  component?: ShellComponent | (() => Promise<ShellComponent>);
}

export class MithicShell {
  readonly #wasiShim: WASIShim;
  readonly #wasiProcess: WASIProcess;
  readonly #component?: ShellComponent | (() => Promise<ShellComponent>);
  readonly #foreground: Set<Process> = new Set();

  constructor(config?: MithicShellConfig) {
    this.#wasiShim = new WASIShim(config?.wasi);
    this.#wasiProcess = new WASIProcess(config?.process);
    this.#component = config?.component;
  }

  getImportObject(): Record<string, object> {
    const base = {
      ...this.#wasiShim.getImportObject(),
      ...this.#wasiProcess.getImportObject(),
    };

    const mgr = base['mithic:process/manager'] as Record<string, Function>;
    const originalSpawn = mgr.spawn;
    const fg = this.#foreground;

    mgr.spawn = (file: string, args: string[], options?: SpawnOptions) => {
      const proc: Process = originalSpawn(file, args, options);
      const originalWait = proc.wait.bind(proc);
      proc.wait = () => {
        fg.add(proc);
        return originalWait().then((code: number) => {
          fg.delete(proc);
          return code;
        });
      };
      return proc;
    };

    return base;
  }

  get processManager(): ProcessManager { return this.#wasiProcess.manager; }

  signal(sig: Signal): void {
    for (const proc of this.#foreground) {
      proc.kill(sig);
    }
  }

  get hasForeground(): boolean {
    return this.#foreground.size > 0;
  }

  async run(): Promise<number> {
    const component = typeof this.#component === 'function'
      ? await this.#component()
      : this.#component;

    if (!component) {
      throw new Error('No shell component provided. Pass component in MithicShellConfig.');
    }

    const { instantiate, modules } = component;
    const { run } = await instantiate(
      async (path: string) => {
        const mod = modules[path];
        if (!mod) throw new Error(`Module not found: ${path}`);
        return WebAssembly.compile(await (await fetch(mod)).arrayBuffer());
      },
      this.getImportObject(),
    );

    return run.run();
  }
}
