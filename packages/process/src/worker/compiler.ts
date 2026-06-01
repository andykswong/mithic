import type { CallHandler } from '@mithic/io/io';

export const CALL_COMPILE = 1;

const moduleCache = new Map<string, { modules: Record<string, Uint8Array>; jsFiles: Record<string, string> }>();

function contentHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const compilerHandler: CallHandler = async (call, _id, payload) => {
  if (call !== CALL_COMPILE) throw new Error(`Unknown call: ${call}`);

  const raw = payload as { bytes: Uint8Array };
  // sync-bridge may deliver bytes with SAB backing. Ensure regular ArrayBuffer for jco.
  const bytes = new Uint8Array(raw.bytes);
  const key = contentHash(bytes);
  if (bytes.length === 0) throw new Error('Empty bytes received');

  if (moduleCache.has(key)) {
    return { ...moduleCache.get(key)!, cached: true };
  }

  let transpile: (bytes: Uint8Array, opts?: unknown) => Promise<{ files: Record<string, unknown> }>;
  try {
    ({ transpile } = await import('@bytecodealliance/jco') as { transpile: typeof transpile });
  } catch {
    throw new Error(
      '@bytecodealliance/jco is required for dynamic WASM component execution. '
      + 'Install it: npm install @bytecodealliance/jco',
    );
  }
  const transpiled = await transpile(bytes, {
    name: 'component',
    instantiation: 'async',
    importBindings: 'hybrid',
    nodejsCompat: true,
    namespacedExports: false,
    typescript: false,
    minify: true,
    map: {},
  });

  const modules: Record<string, Uint8Array> = {};
  const jsFiles: Record<string, string> = {};

  for (const [path, content] of Object.entries(transpiled.files)) {
    if (path.endsWith('.wasm')) {
      modules[path] = content as Uint8Array;
    } else if (path.endsWith('.js')) {
      jsFiles[path] = content as string;
    }
  }

  moduleCache.set(key, { modules, jsFiles });
  return { modules, jsFiles, cached: false };
};
