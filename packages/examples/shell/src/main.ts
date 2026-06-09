import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MemoryFsProvider, DeviceFsProvider, FileSystemRouter } from '@mithic/io/vfs';
import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';
import type { CompileResult } from '@mithic/process/component/compiler';
import type { ProcessWorker } from '@mithic/process/types';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import { Runtime } from '@mithic/shell';
import { modules as shellModules } from '@mithic/shell/component';
import { modules as coreutilsModules } from '@mithic/coreutils/component';
import { modules as rustCliModules } from '@mithic/example-rust-cli/component';
import shellJsSource from '@mithic/shell/component.js?raw';
import coreutilsJsSource from '@mithic/coreutils/component.js?raw';
import rustCliJsSource from '@mithic/example-rust-cli/component.js?raw';
import { createTerminalStdio } from './terminal.ts';
import { BASHRC } from './bashrc.ts';

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

const [shellRawModules, coreutilsRawModules, rustCliRawModules] = await Promise.all([
  fetchModuleBytes(shellModules),
  fetchModuleBytes(coreutilsModules),
  fetchModuleBytes(rustCliModules),
]);

// --- Build CompileResults ---

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
const rustCliCompileResult: CompileResult = {
  modules: rustCliRawModules,
  jsFiles: { 'component.js': rustCliJsSource },
  cached: true,
};

// --- Process Web Worker (local shim that imports @mithic/process/worker/process) ---

function createWebWorker(name?: string): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name });
}

// --- createWorker factory: resolves command names to ProcessWorkers ---

function createWorker(file: string, name?: string): ProcessWorker | undefined {
  const cmdName = file.includes('/') ? file.split('/').pop()! : file;
  if (cmdName === 'sh' || cmdName === 'bash') {
    return new ComponentProcessWorker(createWebWorker(name), shellCompileResult);
  }
  if (COREUTILS_COMMANDS.has(cmdName)) {
    return new ComponentProcessWorker(createWebWorker(name), coreutilsCompileResult);
  }
  if (cmdName === 'rust-cli') {
    return new ComponentProcessWorker(createWebWorker(name), rustCliCompileResult);
  }
  return undefined;
}

// --- Setup terminal stdio and VFS ---

const { stdin, stdout, stderr } = createTerminalStdio(terminal);

const memFs = new MemoryFsProvider();
memFs.mkdir('/home');
memFs.mkdir('/tmp');
memFs.mkdir('/bin');

for (const cmd of [...COREUTILS_COMMANDS, 'rust-cli']) {
  const h = memFs.open(`/bin/${cmd}`, { create: true, write: true });
  memFs.close(h);
  memFs.chmod(`/bin/${cmd}`, 0o755);
}

// --- Write ~/.bashrc for interactive welcome ---

const bashrcHandle = memFs.open('/home/.bashrc', { create: true, write: true });
memFs.write(bashrcHandle, new TextEncoder().encode(BASHRC), 0);
memFs.close(bashrcHandle);

const vfs = new FileSystemRouter();
await vfs.mount('/', memFs);
await vfs.mount('/dev', new DeviceFsProvider());

// --- Create Runtime ---

const runtime = new Runtime({
  fs: vfs,
  stdio: { stdin, stdout, stderr },
  isatty: { stdin: true, stdout: true, stderr: true },
  env: { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color', PWD: '/home' },
  cwd: '/home',
  createWorker,
});

// --- Execute bash and wait for exit ---

const proc = runtime.exec('bash');
const exitCode = await runtime.waitAsync(proc);

runtime[Symbol.dispose]();
terminal.writeln(`\r\n[shell exited with code ${exitCode}]`);
