import { WASIShim, type WASIShimConfig } from '@mithic/wasip2';
import { ComponentExit } from '@mithic/wasip2/cli/exit';
import { WASIProcess, type WASIProcessConfig } from '@mithic/process/instantiation';
import type { ProcessManager, Signal } from '@mithic/process/types';

export interface ShellComponent {
  instantiate(
    compileCore: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, object>,
  ): Promise<{ run: { run: () => number } }>;
  modules: Record<string, string>;
}

export interface SyncShellComponent {
  instantiate(
    compileCore: (path: string) => WebAssembly.Module,
    imports: object,
    instantiateCore: (module: WebAssembly.Module, imports: WebAssembly.Imports) => WebAssembly.Instance,
  ): { run: { run: () => number } };
  compileCore: (path: string) => WebAssembly.Module;
}

export interface MithicShellConfig {
  wasi?: WASIShimConfig;
  process?: WASIProcessConfig;
  component?: ShellComponent | (() => Promise<ShellComponent>);
  syncComponent?: SyncShellComponent;
}

export class MithicShell implements Disposable {
  readonly #wasiShim: WASIShim;
  readonly #wasiProcess: WASIProcess;
  readonly #component?: ShellComponent | (() => Promise<ShellComponent>);
  readonly #syncComponent?: SyncShellComponent;

  constructor(config?: MithicShellConfig) {
    this.#wasiShim = new WASIShim(config?.wasi);
    this.#wasiProcess = new WASIProcess(config?.process);
    this.#component = config?.component;
    this.#syncComponent = config?.syncComponent;
  }

  getImportObject(): Record<string, object> {
    return {
      ...this.#wasiShim.getImportObject(),
      ...this.#wasiProcess.getImportObject(),
    };
  }

  get processManager(): ProcessManager { return this.#wasiProcess.manager; }

  signal(sig: Signal): void {
    this.processManager.signal(sig);
  }

  get hasForeground(): boolean {
    return this.processManager.hasForeground;
  }

  runSync(): number {
    if (!this.#syncComponent) {
      throw new Error('No sync shell component provided. Pass syncComponent in MithicShellConfig.');
    }
    const { instantiate, compileCore } = this.#syncComponent;
    try {
      const { run } = instantiate(compileCore, this.getImportObject(), (mod, imports) => new WebAssembly.Instance(mod, imports));
      return run.run();
    } catch (e: unknown) {
      if (e instanceof ComponentExit) return e.code;
      throw e;
    }
  }

  async run(): Promise<number> {
    if (this.#syncComponent) return this.runSync();
    const component = typeof this.#component === 'function'
      ? await this.#component()
      : this.#component;

    if (!component) {
      throw new Error('No shell component provided. Pass component or syncComponent in MithicShellConfig.');
    }

    const { instantiate, modules } = component;
    try {
      const { run } = await instantiate(
        async (path: string) => {
          const mod = modules[path];
          if (!mod) throw new Error(`Module not found: ${path}`);
          return WebAssembly.compile(await (await fetch(mod)).arrayBuffer());
        },
        this.getImportObject(),
      );
      return run.run();
    } catch (e: unknown) {
      if (e instanceof ComponentExit) return e.code;
      throw e;
    }
  }

  [Symbol.dispose](): void {
    this.#wasiShim[Symbol.dispose]();
  }
}
