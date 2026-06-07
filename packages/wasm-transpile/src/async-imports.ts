/**
 * WASI and mithic:process imports that should be considered asynchronous (may block/suspend).
 * Format: 'namespace:package/interface#function-name' (unversioned, JCO asyncImports format).
 */
export const ASYNC_WASI_IMPORTS = [
  'wasi:io/poll#poll',
  'wasi:io/poll#[method]pollable.block',
  'wasi:io/streams#[method]input-stream.blocking-read',
  'wasi:io/streams#[method]input-stream.blocking-skip',
  'wasi:io/streams#[method]output-stream.blocking-flush',
  'wasi:io/streams#[method]output-stream.blocking-write-and-flush',
  'wasi:io/streams#[method]output-stream.blocking-write-zeroes-and-flush',
  'wasi:io/streams#[method]output-stream.blocking-splice',
  'mithic:process/types#[method]process.wait',
];

/**
 * WASI exports that should be considered asynchronous (entry points that may suspend).
 * Format: 'namespace:package/interface#function-name' (unversioned, JCO asyncExports format).
 */
export const ASYNC_WASI_EXPORTS = [
  'wasi:cli/run#run',
  'wasi:http/incoming-handler#handle',
];

/**
 * Check if a versioned WASM import (e.g. 'wasi:io/poll@0.2.0.[method]pollable.block')
 * matches an unversioned async import spec (e.g. 'wasi:io/poll#[method]pollable.block').
 *
 * Versioned format: `namespace:package/interface@version.function-name`
 * Unversioned format: `namespace:package/interface#function-name`
 */
export function matchesAsyncImport(
  module: string,
  name: string,
  asyncImports: Iterable<string>,
): boolean {
  const stripped = stripVersion(module);
  const key = `${stripped}#${name}`;
  for (const spec of asyncImports) {
    if (spec === key) return true;
  }
  return false;
}

/**
 * Resolve unversioned async import specs against actual module imports
 * to produce the versioned `module.name` format that binaryen's asyncify pass expects.
 */
export function resolveVersionedImports(
  moduleImports: readonly { module: string; name: string }[],
  asyncImports: readonly string[],
): string[] {
  const result: string[] = [];
  for (const imp of moduleImports) {
    if (matchesAsyncImport(imp.module, imp.name, asyncImports)) {
      result.push(`${imp.module}.${imp.name}`);
    }
  }
  return result;
}

function stripVersion(module: string): string {
  return module.replace(/@[^/]+$/, '');
}
