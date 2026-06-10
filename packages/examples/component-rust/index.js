import { isatty } from 'node:tty';
import { WASIShim } from '@mithic/wasip2';
import { NodeStdinHandler, NodeAsyncStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';

const mode = process.argv[2];
let instantiateModule;
let modules;
let instantiateCore;

if (mode === '--asyncify') {
  const { installPolyfill, createInstantiateCore } = await import('@mithic/wasm-transpile');
  const polyfill = installPolyfill({ overrideNative: true });
  console.log(`[asyncify] polyfill installed${polyfill.overrodeNative ? ' (overriding native JSPI)' : ''}`);
  const entry = await import('./dist/asyncify.js');
  instantiateModule = entry.instantiate;
  modules = entry.modules;
  instantiateCore = createInstantiateCore();
} else if (mode === '--jspi') {
  const entry = await import('./dist/jspi.js');
  instantiateModule = entry.instantiate;
  modules = entry.modules;
} else {
  const entry = await import('./dist/index.js');
  instantiateModule = entry.instantiate;
  modules = entry.modules;
}

const isAsync = mode === '--asyncify' || mode === '--jspi';

function compileCore(path) {
  const uri = modules[path];
  if (!uri) throw new Error(`Unknown module: ${path}`);
  const base64 = uri.split(',')[1];
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return WebAssembly.compile(bytes);
}

const shim = new WASIShim({
  async: isAsync,
  sandbox: {
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)),
    args: process.argv.slice(1).filter(a => a !== '--asyncify' && a !== '--jspi'),
    stdin: { handler: isAsync ? new NodeAsyncStdinHandler() : new NodeStdinHandler(), isatty: isatty(0) },
    stdout: { handler: new NodeStdoutHandler(), isatty: isatty(1) },
    stderr: { handler: new NodeStderrHandler(), isatty: isatty(2) },
  }
});

const { run } = await instantiateModule(
  compileCore,
  shim.getImportObject(),
  instantiateCore,
);

const exitCode = await run.run();
process.exit(exitCode ?? 0);
