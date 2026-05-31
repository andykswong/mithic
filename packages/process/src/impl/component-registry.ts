import type { CompilerBridge } from './compiler-bridge.ts';

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

export interface ResolvedComponent {
  type: 'precompiled' | 'dynamic';
  compileCore: (path: string) => WebAssembly.Module;
  instantiate: SyncInstantiateFn;
}

export interface ComponentRegistryConfig {
  precompiled?: Map<string, PrecompiledComponent>;
  compiler?: CompilerBridge;
}

export class ComponentRegistry implements Disposable {
  readonly #precompiled: Map<string, PrecompiledComponent>;
  readonly #compiler?: CompilerBridge;
  readonly #cache = new Map<string, ResolvedComponent>();

  constructor(config: ComponentRegistryConfig) {
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

  resolve(name: string): ResolvedComponent | undefined {
    for (const component of this.#precompiled.values()) {
      if (component.commands.has(name)) {
        return { type: 'precompiled', compileCore: component.compileCore, instantiate: component.instantiate };
      }
    }
    return this.#cache.get(name);
  }

  resolveBytes(bytes: Uint8Array, cacheKey?: string): ResolvedComponent | undefined {
    if (!this.#compiler) return undefined;
    if (!ComponentRegistry.isWasmComponent(bytes)) return undefined;
    if (cacheKey && this.#cache.has(cacheKey)) return this.#cache.get(cacheKey);

    const result = this.#compiler.compile(bytes);

    const compiled = new Map<string, WebAssembly.Module>();
    for (const [path, wasmBytes] of Object.entries(result.modules)) {
      compiled.set(path, new WebAssembly.Module(wasmBytes.slice().buffer));
    }

    const compileCore = (path: string): WebAssembly.Module => {
      const mod = compiled.get(path);
      if (!mod) throw new Error(`Module not found: ${path}`);
      return mod;
    };

    const jsSource = result.jsFiles?.['component.js'];
    if (!jsSource) {
      throw new Error('Compiler did not return component.js');
    }
    const instantiate = this.#evalInstantiate(jsSource);

    const resolved: ResolvedComponent = { type: 'dynamic', compileCore, instantiate };
    if (cacheKey) this.#cache.set(cacheKey, resolved);
    return resolved;
  }

  #evalInstantiate(jsSource: string): SyncInstantiateFn {
    const stripped = jsSource
      .replace(/^export\s+/gm, '')
      .replace(/^import\s+.*$/gm, '')
      .replace(/import\.meta/g, '__importMeta');
    // Provide a mock import.meta since jco references import.meta.url for module resolution.
    // In our case compileCore handles resolution, so import.meta.url is unused at runtime.
    const fn = new Function('__importMeta', `${stripped}\nreturn instantiate;`)({ url: 'file:///dynamic' });
    return fn as SyncInstantiateFn;
  }

  [Symbol.dispose](): void {
    this.#compiler?.[Symbol.dispose]();
  }
}
