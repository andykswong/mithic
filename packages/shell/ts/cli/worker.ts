import '@mithic/worker';
import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeAsyncStdinHandler, NodeStdoutHandler, NodeStderrHandler } from '@mithic/io/io/providers/node-stdio';
import { NodeSocketProvider } from '@mithic/io/net/providers/node-socket-provider';
import { FetchHttpClient } from '@mithic/io/net';
import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';
import { InlineProcessWorker } from '@mithic/process/manager/inline-worker';
import type { CompileResult } from '@mithic/process/component/compiler';
import { createComponentCompiler } from '@mithic/process/component/compiler';
import { CommandRegistry } from '@mithic/process/component/registry';
import type { ProcessWorker } from '@mithic/process/types';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { JQ_COMMAND } from '@mithic/jq';
import { CURL_COMMAND } from '@mithic/curl';
import { modules as shellModules } from '@mithic/shell/component';
import { modules as coreutilsModules } from '@mithic/coreutils/component';
import { modules as jqModules } from '@mithic/jq/component';
import { modules as curlModules } from '@mithic/curl/component';
import { outputFromSharedBuffer } from '@mithic/process/io';
import { runChmod } from '../commands/chmod.ts';
import { Runtime } from '../runtime.ts';
import { createWorkerStrategy } from '../worker-strategy.ts';
import { createNodeVfs, mountNodeVfs, getNodeEnv } from './shared.ts';

// --- Fetch raw module bytes (needed for CompileResult sent to process Workers) ---

async function fetchModuleBytes(dataUris: Record<string, string>): Promise<Record<string, Uint8Array>> {
  const modules: Record<string, Uint8Array> = {};
  await Promise.all(
    Object.entries(dataUris).map(async ([name, uri]) => {
      const response = await fetch(uri);
      modules[name] = new Uint8Array(await response.arrayBuffer());
    }),
  );
  return modules;
}

const [shellRawModules, coreutilsRawModules, jqRawModules, curlRawModules] = await Promise.all([
  fetchModuleBytes(shellModules),
  fetchModuleBytes(coreutilsModules),
  fetchModuleBytes(jqModules),
  fetchModuleBytes(curlModules),
]);

// --- Read jco JS sources (needed for CompileResult sent to process Workers) ---

const shellComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/shell/component')));
const coreutilsComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/coreutils/component')));
const jqComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/jq/component')));
const curlComponentDir = dirname(fileURLToPath(import.meta.resolve('@mithic/curl/component')));
const shellJsSource = readFileSync(join(shellComponentDir, 'component.js'), 'utf-8');
const coreutilsJsSource = readFileSync(join(coreutilsComponentDir, 'component.js'), 'utf-8');
const jqJsSource = readFileSync(join(jqComponentDir, 'component.js'), 'utf-8');
const curlJsSource = readFileSync(join(curlComponentDir, 'component.js'), 'utf-8');

// --- Build CompileResults for process Workers ---

const shellCompileResult: CompileResult = {
  modules: shellRawModules,
  jsFiles: { 'component.js': shellJsSource },
  cached: true,
};
const coreutilsCompileResult: CompileResult = {
  modules: coreutilsRawModules,
  jsFiles: { 'component.js': coreutilsJsSource },
  cached: true,
};
const jqCompileResult: CompileResult = {
  modules: jqRawModules,
  jsFiles: { 'component.js': jqJsSource },
  cached: true,
};
const curlCompileResult: CompileResult = {
  modules: curlRawModules,
  jsFiles: { 'component.js': curlJsSource },
  cached: true,
};

// --- Setup compiler for dynamic WASM ---

const { port1: compilerPort1, port2: compilerPort2 } = new MessageChannel();
const compilerWorker = new Worker(
  new URL(import.meta.resolve('@mithic/process/worker/compiler')),
  { type: 'module', name: 'mithic-compiler' },
);
compilerWorker.postMessage({ type: '__port', port: compilerPort2 }, [compilerPort2]);
const compilerBridge = createComponentCompiler(compilerPort1 as unknown as MessagePort);
const registry = new CommandRegistry({ compiler: compilerBridge });

// --- Shared VFS ---

const hostStderr = new NodeStderrHandler();
const nodeSocketProvider = new NodeSocketProvider();
const { memFs, hostFs, vfs } = createNodeVfs();
await mountNodeVfs(vfs, memFs, hostFs, { sockets: nodeSocketProvider });

// --- Command resolver ---

const processWorkerUrl = new URL(import.meta.resolve('@mithic/process/worker/process'));

function resolveFromPath(file: string, env: Record<string, string>): string | undefined {
  if (file.includes('/')) {
    try { memFs.stat(file); return file; } catch { return undefined; }
  }
  const pathDirs = (env['PATH'] ?? '/usr/bin:/bin').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = `${dir}/${file}`;
    try {
      const stat = memFs.stat(candidate);
      if (stat.mode & 0o111) return candidate;
    } catch { /* not found */ }
  }
  return undefined;
}

function createScriptWorker(path: string, name?: string): ProcessWorker | undefined {
  try {
    const stat = memFs.stat(path);
    if (!(stat.mode & 0o111)) return undefined;
    const handle = memFs.open(path, { read: true });
    let bytes: Uint8Array;
    try { bytes = memFs.read(handle, 0, Number(stat.size)); }
    finally { memFs.close(handle); }

    if (CommandRegistry.isWasmComponent(bytes)) {
      const result = registry.resolveBytes(bytes, path);
      if (!result) return undefined;
      const worker = new Worker(processWorkerUrl, { type: 'module', name });
      return new ComponentProcessWorker(worker, result);
    }

    const text = new TextDecoder().decode(bytes);
    let interpreter = 'sh';
    let interpArgs: string[] = [];
    if (text.startsWith('#!')) {
      const firstLine = text.split('\n')[0].slice(2).trim();
      const parts = firstLine.split(/\s+/);
      interpreter = parts[0];
      interpArgs = parts.slice(1);
    }
    const interpName = interpreter.includes('/') ? interpreter.split('/').pop()! : interpreter;
    if (interpName === 'sh' || interpName === 'bash') {
      const worker = new Worker(processWorkerUrl, { type: 'module', name });
      const pw = new ComponentProcessWorker(worker, shellCompileResult);
      return {
        run(options, transfer) {
          const scriptArgs = options.args.slice(1);
          pw.run({ ...options, args: [interpName, ...interpArgs, path, ...scriptArgs] }, transfer);
        },
        terminate: () => pw.terminate(),
        addEventListener: (type, handler) => pw.addEventListener(type, handler),
      };
    }
    const errorMsg = `${path}: ${interpreter}: interpreter not found\n`;
    return new InlineProcessWorker((opts) => {
      if (opts.inheritStderr) {
        hostStderr.write(new TextEncoder().encode(errorMsg));
      } else {
        const stderr = outputFromSharedBuffer(opts.stderrBuf, opts.stderrBufSize);
        stderr.write(new TextEncoder().encode(errorMsg));
        stderr[Symbol.dispose]();
      }
      return 127;
    });
  } catch { return undefined; }
}

function createWorker(file: string, name?: string): ProcessWorker | undefined {
  const cmdName = file.includes('/') ? file.split('/').pop()! : file;
  if (cmdName === 'chmod') {
    return new InlineProcessWorker((opts) => {
      const chmodArgs = opts.args.slice(1);
      const writeErr = (msg: string) => {
        if (opts.inheritStderr) {
          hostStderr.write(new TextEncoder().encode(msg));
        } else {
          const stderr = outputFromSharedBuffer(opts.stderrBuf, opts.stderrBufSize);
          stderr.write(new TextEncoder().encode(msg));
          stderr[Symbol.dispose]();
        }
      };
      return runChmod(chmodArgs, memFs, writeErr);
    });
  }
  if (cmdName === 'sh' || cmdName === 'bash') {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, shellCompileResult);
  }
  if (cmdName === JQ_COMMAND) {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, jqCompileResult);
  }
  if (cmdName === CURL_COMMAND) {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, curlCompileResult);
  }
  if (COREUTILS_COMMANDS.has(cmdName)) {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, coreutilsCompileResult);
  }
  if (file.includes('/')) {
    return createScriptWorker(file, name);
  }
  const resolved = resolveFromPath(file, {});
  if (resolved) return createScriptWorker(resolved, name);
  return undefined;
}

// --- Create Runtime ---

const manager = createWorkerStrategy({
  fs: vfs,
  http: new FetchHttpClient(),
  sockets: nodeSocketProvider,
  stdio: {
    stdin: new NodeAsyncStdinHandler(),
    stdout: new NodeStdoutHandler(),
    stderr: new NodeStderrHandler(),
  },
  isatty: { stdin: isatty(0), stdout: isatty(1), stderr: isatty(2) },
  createWorker,
  maxWorkers: 8,
});

const runtime = new Runtime({
  manager,
  env: getNodeEnv(),
  cwd: '/root',
});

// --- Execute shell and wait for exit ---

const proc = runtime.exec('bash', {
  args: process.argv.slice(2),
});
const exitCode = await runtime.waitAsync(proc);

runtime[Symbol.dispose]();
registry[Symbol.dispose]();
compilerWorker.terminate();
process.exit(exitCode);
