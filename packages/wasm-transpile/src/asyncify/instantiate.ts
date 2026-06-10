import { Asyncify } from './state.ts';
import { asyncifyRegistry, Suspending } from './polyfill.ts';
import { ASYNC_WASI_IMPORTS, matchesAsyncImport } from '../async-imports.ts';

type AnyFn = (...args: unknown[]) => unknown;

export interface InstantiateOptions {
  asyncify?: boolean;
  asyncImports?: string[];
}

/**
 * Creates a custom `instantiateCore` function that integrates asyncify with
 * JCO's multi-module architecture.
 *
 * Each asyncified module gets its own Asyncify instance (bound to its own
 * secondary memory), so multiple components can run concurrently.
 *
 * JCO generates 3 types of core WASM modules:
 * - **Shim** (core2): exports a table + numbered functions
 * - **Asyncified core** (core): imports from WASI namespaces
 * - **Linker** (core3): fills the shim's table with JS trampolines
 */
export function createInstantiateCore(opts?: InstantiateOptions) {
  const asyncifyEnabled = opts?.asyncify ?? true;
  const asyncImports = opts?.asyncImports ?? ASYNC_WASI_IMPORTS;

  const tableFns = new Map<number, AnyFn>();
  const shimFnToIndex = new Map<WebAssembly.ImportValue, number>();

  return async (module: WebAssembly.Module, imports?: WebAssembly.Imports) => {
    const modExports = WebAssembly.Module.exports(module);
    const modImports = WebAssembly.Module.imports(module);
    const hasAsyncify = asyncifyEnabled &&
      modExports.some((e: WebAssembly.ModuleExportDescriptor) => e.name === 'asyncify_get_state') &&
      modExports.some((e: WebAssembly.ModuleExportDescriptor) => e.name === 'asyncify_memory');

    const processed: WebAssembly.Imports = {};
    if (imports) {
      for (const [mod, fns] of Object.entries(imports)) {
        processed[mod] = {};
        for (const [name, val] of Object.entries(fns as Record<string, unknown>)) {
          (processed[mod] as Record<string, WebAssembly.ImportValue>)[name] =
            (val instanceof Suspending ? val.__asyncify_fn : val) as WebAssembly.ImportValue;
        }
      }
    }

    if (hasAsyncify) {
      const asyncify = new Asyncify();

      for (const [mod, fns] of Object.entries(processed)) {
        for (const [name, val] of Object.entries(fns as Record<string, unknown>)) {
          if (typeof val !== 'function') continue;
          const isAsync = matchesAsyncImport(mod, name, asyncImports);
          const shimIdx = shimFnToIndex.get(val as WebAssembly.ImportValue);

          if (isAsync && shimIdx !== undefined) {
            const idx = shimIdx;
            (processed[mod] as Record<string, WebAssembly.ImportValue>)[name] =
              asyncify.wrapImportFn((...args: unknown[]) => {
                const fn = tableFns.get(idx);
                if (!fn) throw new Error(`[asyncify] table slot ${idx} not yet populated`);
                return fn(...args);
              }) as WebAssembly.ImportValue;
          } else if (isAsync) {
            (processed[mod] as Record<string, WebAssembly.ImportValue>)[name] =
              asyncify.wrapImportFn(val as AnyFn) as WebAssembly.ImportValue;
          }
        }
      }

      const instance = await WebAssembly.instantiate(module, processed);
      asyncify.init(instance);

      // Register all exports so promising() can find this asyncify instance
      for (const name of Object.keys(instance.exports)) {
        const exp = instance.exports[name];
        if (typeof exp === 'function') {
          asyncifyRegistry.set(exp as object, asyncify);
        }
      }

      return instance;
    }

    const instance = await WebAssembly.instantiate(module, processed);

    const tableExport = modExports.find((e: WebAssembly.ModuleExportDescriptor) => e.kind === 'table');
    const hasNumberedExports = modExports.some(
      (e: WebAssembly.ModuleExportDescriptor) => e.kind === 'function' && !isNaN(parseInt(e.name, 10)),
    );

    if (tableExport && hasNumberedExports) {
      for (const exp of modExports) {
        if (exp.kind !== 'function') continue;
        const idx = parseInt(exp.name, 10);
        if (isNaN(idx)) continue;
        shimFnToIndex.set(instance.exports[exp.name] as WebAssembly.ImportValue, idx);
      }
    } else if (modImports.some((i: WebAssembly.ModuleImportDescriptor) => i.kind === 'table')) {
      if (imports) {
        for (const [, fns] of Object.entries(imports)) {
          for (const [name, val] of Object.entries(fns as Record<string, unknown>)) {
            const idx = parseInt(name, 10);
            if (isNaN(idx)) continue;
            const rawFn = val instanceof Suspending ? val.__asyncify_fn : val;
            if (typeof rawFn === 'function') {
              tableFns.set(idx, rawFn as AnyFn);
            }
          }
        }
      }
    }

    return instance;
  };
}
