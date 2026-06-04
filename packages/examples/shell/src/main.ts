import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MemoryFsProvider } from '@mithic/io/vfs';
import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';
import type { CompileResult } from '@mithic/process/component/compiler';
import type { ProcessWorker } from '@mithic/process/types';
import { Runtime } from '@mithic/shell';
import { modules as shellModules } from '@mithic/shell/component';
import { createTerminalStdio } from './terminal.ts';

const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b7066',
  },
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById('terminal')!);
fitAddon.fit();

window.addEventListener('resize', () => fitAddon.fit());

// --- Fetch shell component module bytes for process Workers ---

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

const shellRawModules = await fetchModuleBytes(shellModules);

// --- Build shell CompileResult ---
// The component.js is co-located with the modules in @mithic/shell/component.
// In Vite, we resolve the URL at runtime and fetch the JS source as text.

const shellComponentBaseUrl = new URL('.', import.meta.resolve('@mithic/shell/component'));
const shellJsSource = await (await fetch(new URL('component.js', shellComponentBaseUrl))).text();

const shellCompileResult: CompileResult = {
  modules: shellRawModules,
  jsFiles: { 'component.js': shellJsSource },
  cached: true,
};

// --- Process Worker URL (local shim that imports @mithic/process/worker/process) ---

const processWorkerUrl = new URL('./worker.ts', import.meta.url);

// --- createWorker factory: resolves command names to ProcessWorkers ---

function createWorker(file: string, name?: string): ProcessWorker | undefined {
  const cmdName = file.includes('/') ? file.split('/').pop()! : file;
  if (cmdName === 'sh' || cmdName === 'bash') {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, shellCompileResult);
  }
  return undefined;
}

// --- Setup terminal stdio and VFS ---

const { stdin, stdout, stderr } = createTerminalStdio(terminal);

const memFs = new MemoryFsProvider();
memFs.mkdir('/home');
memFs.mkdir('/tmp');
memFs.mkdir('/bin');

// --- Create Runtime ---

const runtime = new Runtime({
  fs: memFs,
  stdio: { stdin, stdout, stderr },
  isatty: { stdin: true, stdout: true, stderr: true },
  env: { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color', PWD: '/home' },
  cwd: '/home',
  createWorker,
});

// --- Execute bash and wait for exit ---

const proc = runtime.exec('bash', { args: ['bash'] });
const exitCode = await runtime.waitAsync(proc);

runtime[Symbol.dispose]();
terminal.writeln(`\r\n[shell exited with code ${exitCode}]`);
