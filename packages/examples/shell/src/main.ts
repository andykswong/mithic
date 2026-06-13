import { createTerminal, createVfs, mountVfs, runShell } from './shell.ts';
import { createTerminalStdio } from './terminal.ts';

const mode = new URLSearchParams(location.search).get('mode') ?? 'async';

const terminal = createTerminal();
const { stdin, stdout, stderr } = createTerminalStdio(terminal);
const { memFs, vfs } = createVfs(mode);
await mountVfs(vfs, memFs);

let manager;
if (mode === 'worker') {
  const { createWorkerManager } = await import('./mode-worker.ts');
  manager = await createWorkerManager(vfs, { stdin, stdout, stderr });
} else {
  const { createAsyncManager } = await import('./mode-async.ts');
  manager = await createAsyncManager(vfs, { stdin, stdout, stderr });
}

const exitCode = await runShell(manager);
terminal.writeln(`\r\n[shell exited with code ${exitCode}]`);
