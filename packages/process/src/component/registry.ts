import type { ComponentCompiler, CompileResult } from './compiler.ts';

export { type CompileResult } from './compiler.ts';

export type SyncInstantiateFn = (
  compileCore: (path: string) => WebAssembly.Module,
  imports: object,
  instantiateCore: (module: WebAssembly.Module, imports: WebAssembly.Imports) => WebAssembly.Instance,
) => { run: { run: () => number } };

export interface PrecompiledComponent {
  commands: Set<string>;
  compileCore: (path: string) => WebAssembly.Module;
  instantiate: SyncInstantiateFn;
}

export interface CommandRegistryConfig {
  precompiled?: Map<string, PrecompiledComponent>;
  compiler?: ComponentCompiler;
}

export class CommandRegistry implements Disposable {
  readonly #precompiled: Map<string, PrecompiledComponent>;
  readonly #compiler?: ComponentCompiler;
  readonly #cache = new Map<string, CompileResult>();

  constructor(config: CommandRegistryConfig) {
    this.#precompiled = config.precompiled ?? new Map();
    this.#compiler = config.compiler;
  }

  static isWasmComponent(bytes: Uint8Array): boolean {
    return bytes.length >= 4
      && bytes[0] === 0x00
      && bytes[1] === 0x61
      && bytes[2] === 0x73
      && bytes[3] === 0x6d;
  }

  resolvePrecompiled(name: string): PrecompiledComponent | undefined {
    for (const component of this.#precompiled.values()) {
      if (component.commands.has(name)) return component;
    }
    return undefined;
  }

  resolveBytes(bytes: Uint8Array, cacheKey?: string): CompileResult | undefined {
    if (!this.#compiler) return undefined;
    if (!CommandRegistry.isWasmComponent(bytes)) return undefined;
    if (cacheKey && this.#cache.has(cacheKey)) return this.#cache.get(cacheKey);

    const result = this.#compiler.compile(bytes);
    if (cacheKey) this.#cache.set(cacheKey, result);
    return result;
  }

  [Symbol.dispose](): void {
    this.#compiler?.[Symbol.dispose]();
  }
}
