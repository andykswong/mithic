import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { transpile as jcoTranspile } from '@bytecodealliance/jco';
import { asyncifyTransform } from './asyncify/transform.ts';
import { resolveVersionedImports } from './async-imports.ts';
export { ASYNC_WASI_IMPORTS, ASYNC_WASI_EXPORTS, matchesAsyncImport, resolveVersionedImports } from './async-imports.ts';

export interface TranspileOptions {
  name?: string;
  minify?: boolean;
  asyncMode?: 'sync' | 'jspi' | 'asyncify';
  asyncImports?: string[];
  asyncExports?: string[];
  asyncifyPages?: number;
}

export interface TranspileResult {
  files: Map<string, Uint8Array>;
  imports: string[];
  exports: [string, 'function' | 'instance'][];
}

export interface TranspileToFilesOptions extends TranspileOptions {
  outputDir: string;
  generateIndex?: boolean;
}

/**
 * Transpile a WASM component into JS glue + core WASM modules (in-memory).
 * When asyncMode is 'asyncify', transpiles with JSPI mode then runs asyncify on core modules.
 */
export async function transpileComponent(component: Uint8Array, opts?: TranspileOptions): Promise<TranspileResult> {
  const jcoAsyncMode = opts?.asyncMode === 'asyncify' ? 'jspi' : opts?.asyncMode;

  const jcoOpts: Record<string, unknown> = {
    name: opts?.name ?? 'component',
    instantiation: 'async',
    importBindings: 'hybrid',
    nodejsCompat: true,
    namespacedExports: false,
    minify: opts?.minify ?? true,
    map: {},
  };
  if (jcoAsyncMode) jcoOpts.asyncMode = jcoAsyncMode;
  if (opts?.asyncImports) jcoOpts.asyncImports = opts.asyncImports;
  if (opts?.asyncExports) jcoOpts.asyncExports = opts.asyncExports;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await jcoTranspile(component, jcoOpts as any);
  const files = new Map(Object.entries(result.files));

  if (opts?.asyncMode === 'asyncify') {
    const asyncImports = opts.asyncImports;
    for (const [filename, content] of files) {
      if (!filename.endsWith('.wasm')) continue;
      const mod = new WebAssembly.Module(content as BufferSource);
      const modImports = WebAssembly.Module.imports(mod);
      const hasWasiOrMithic = modImports.some(
        (i: WebAssembly.ModuleImportDescriptor) => i.module.startsWith('wasi:') || i.module.startsWith('mithic:'),
      );
      if (!hasWasiOrMithic) continue;

      const versionedImports = asyncImports
        ? resolveVersionedImports(modImports, asyncImports)
        : undefined;
      files.set(filename, asyncifyTransform(content, {
        asyncImports: versionedImports,
        secondaryMemoryPages: opts.asyncifyPages,
      }));
    }
  }

  return { files, imports: result.imports, exports: result.exports };
}

/**
 * Generate index.js that re-exports the component and provides base64 data URI module map.
 */
export function generateIndexJs(componentName: string, wasmModules: Record<string, string>): string {
  return `export * from './${componentName}.js';\nexport const modules = ${JSON.stringify(wasmModules)};\n`;
}

/**
 * Generate index.d.ts that re-exports types from the JCO-generated component.d.ts
 * and adds the modules map declaration.
 */
export function generateIndexDts(componentName: string): string {
  return `export * from './${componentName}.js';\nexport declare const modules: Record<string, string>;\n`;
}

/**
 * Transpile a WASM component and write all output files to disk.
 * Optionally generates index.js + index.d.ts with base64 module map.
 */
export async function transpileToFiles(component: Uint8Array, opts: TranspileToFilesOptions): Promise<void> {
  const { outputDir, generateIndex = true, ...transpileOpts } = opts;
  const result = await transpileComponent(component, transpileOpts);

  const wasmModules: Record<string, string> = {};

  for (const [filename, content] of result.files) {
    const outPath = join(outputDir, filename);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, content);

    if (filename.endsWith('.wasm')) {
      wasmModules[filename] = `data:content/type;base64,${Buffer.from(content).toString('base64')}`;
    }
  }

  if (generateIndex) {
    const name = transpileOpts.name ?? 'component';
    await writeFile(join(outputDir, 'index.js'), generateIndexJs(name, wasmModules));
    await writeFile(join(outputDir, 'index.d.ts'), generateIndexDts(name));
  }
}
