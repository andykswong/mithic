import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { transpile } from '@bytecodealliance/jco';

const filePath = process.argv[2] ?? './dist/component.wasm';
const outputDir = dirname(filePath);
const component = await readFile(filePath);
const transpiled = await transpile(component, {
  name: basename(filePath, '.wasm'),
  instantiation: 'async',
  importBindings: 'hybrid',
  nodejsCompat: true,
  namespacedExports: false,
  typescript: false,
  minify: true,
  map: {},
});

const fileEntries = Object.entries(transpiled.files);
const wasmCode = {};
for (const [file, content] of fileEntries) {
  const path = join(outputDir, file);
  const dirPath = dirname(path);
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
  await writeFile(path, content);

  if (file.endsWith('.wasm')) {
    wasmCode[file] = `data:content/type;base64,${Buffer.from(content).toString('base64')}`;
  }
}

const indexFile = `
  export * from './component.js';
  export const modules = ${JSON.stringify(wasmCode)};
`;
await writeFile(join(outputDir, 'index.js'), indexFile);

const dtsFile = `export type WasmComponent = { run: { run: () => number } };

export declare function instantiate(
  compileCore: (path: string) => Promise<WebAssembly.Module>,
  imports: Record<string, object>,
): Promise<WasmComponent>;

export declare function instantiate(
  compileCore: (path: string) => WebAssembly.Module,
  imports: Record<string, object>,
  instantiateCore: (module: WebAssembly.Module, imports: WebAssembly.Imports) => WebAssembly.Instance,
): WasmComponent;

export declare const modules: Record<string, string>;
`;
await writeFile(join(outputDir, 'index.d.ts'), dtsFile);

console.info('imports', transpiled.imports);
console.info('exports', transpiled.exports);
