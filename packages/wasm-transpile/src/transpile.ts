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

export interface TranspileToFilesOptions {
  name?: string;
  minify?: boolean;
  outputDir: string;
  asyncImports?: string[];
  asyncExports?: string[];
  asyncifyPages?: number;
  /** Which variants to produce. Default: ['sync']. */
  variants?: Array<'sync' | 'jspi' | 'asyncify'>;
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
    applyAsyncify(files, opts.asyncImports, opts.asyncifyPages);
  }

  return { files, imports: result.imports, exports: result.exports };
}

/**
 * Transpile a WASM component and write variant output files to disk.
 */
export async function transpileToFiles(component: Uint8Array, opts: TranspileToFilesOptions): Promise<void> {
  const { outputDir, variants = ['sync'], name = 'component', minify, asyncifyPages, asyncImports, asyncExports } = opts;

  const wantSync = variants.includes('sync');
  const wantJspi = variants.includes('jspi');
  const wantAsyncify = variants.includes('asyncify');
  const wantAsync = wantJspi || wantAsyncify;

  let syncResult: TranspileResult | undefined;
  let asyncResult: TranspileResult | undefined;

  if (wantSync) {
    syncResult = await transpileComponent(component, { name, minify });
  }

  if (wantAsync) {
    asyncResult = await transpileComponent(component, { name, minify, asyncMode: 'jspi', asyncImports, asyncExports });
  }

  await mkdir(outputDir, { recursive: true });
  const coreDir = join(outputDir, 'core');
  await mkdir(coreDir, { recursive: true });

  const baseResult = syncResult ?? asyncResult!;
  const wasmModules: Record<string, string> = {};

  for (const [filename, content] of baseResult.files) {
    if (!filename.endsWith('.wasm')) continue;
    const base = filename.includes('/') ? filename.split('/').pop()! : filename;
    await writeFile(join(coreDir, base), content);
    wasmModules[filename] = `data:content/type;base64,${Buffer.from(content).toString('base64')}`;
  }

  if (wantSync) {
    const jsFile = syncResult!.files.get(`${name}.js`);
    if (jsFile) await writeFile(join(outputDir, `${name}.js`), jsFile);
  }

  if (wantAsync) {
    const jsFile = asyncResult!.files.get(`${name}.js`);
    if (jsFile) await writeFile(join(outputDir, `${name}.async.js`), jsFile);
  }

  const dtsFile = baseResult.files.get(`${name}.d.ts`);
  if (dtsFile) {
    if (wantSync) await writeFile(join(outputDir, `${name}.d.ts`), dtsFile);
    if (wantAsync) await writeFile(join(outputDir, `${name}.async.d.ts`), dtsFile);
  }

  for (const [filename, content] of baseResult.files) {
    if (filename.startsWith('interfaces/')) {
      const outPath = join(outputDir, filename);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, content);
    }
  }

  let asyncifyModules: Record<string, string> | undefined;
  if (wantAsyncify) {
    asyncifyModules = { ...wasmModules };
    const sourceFiles = asyncResult ?? syncResult!;
    const asyncifyDir = join(outputDir, 'core-asyncify');
    await mkdir(asyncifyDir, { recursive: true });

    for (const [filename, content] of sourceFiles.files) {
      if (!filename.endsWith('.wasm')) continue;
      const base = filename.includes('/') ? filename.split('/').pop()! : filename;
      const mod = new WebAssembly.Module(content as BufferSource);
      const modImports = WebAssembly.Module.imports(mod);
      const hasWasiOrMithic = modImports.some(
        (i: WebAssembly.ModuleImportDescriptor) => i.module.startsWith('wasi:') || i.module.startsWith('mithic:'),
      );

      if (hasWasiOrMithic) {
        const versionedImports = asyncImports
          ? resolveVersionedImports(modImports, asyncImports)
          : undefined;
        const asyncified = asyncifyTransform(content, {
          asyncImports: versionedImports,
          secondaryMemoryPages: asyncifyPages,
        });
        await writeFile(join(asyncifyDir, base), asyncified);
        asyncifyModules[filename] = `data:content/type;base64,${Buffer.from(asyncified).toString('base64')}`;
      } else {
        await writeFile(join(asyncifyDir, base), content);
      }
    }
  }

  if (wantSync) {
    await writeFile(join(outputDir, 'index.js'), generateEntryJs(name, wasmModules));
    await writeFile(join(outputDir, 'index.d.ts'), generateEntryDts(name));
  }

  if (wantJspi) {
    await writeFile(join(outputDir, 'jspi.js'), generateEntryJs(`${name}.async`, wasmModules));
    await writeFile(join(outputDir, 'jspi.d.ts'), generateEntryDts(`${name}.async`));
  }

  if (wantAsyncify) {
    await writeFile(join(outputDir, 'asyncify.js'), generateEntryJs(`${name}.async`, asyncifyModules!));
    await writeFile(join(outputDir, 'asyncify.d.ts'), generateEntryDts(`${name}.async`));
  }
}

function generateEntryJs(modulePath: string, wasmModules: Record<string, string>): string {
  return `export { instantiate } from './${modulePath}.js';\nexport const modules = ${JSON.stringify(wasmModules)};\n`;
}

function generateEntryDts(modulePath: string): string {
  return `export * from './${modulePath}.js';\nexport declare const modules: Record<string, string>;\n`;
}

function applyAsyncify(files: Map<string, Uint8Array>, asyncImports?: string[], asyncifyPages?: number): void {
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
      secondaryMemoryPages: asyncifyPages,
    }));
  }
}
