import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MemoryFsProvider, DeviceFsProvider, FileSystemRouter } from '@mithic/io/vfs';
import { COREUTILS_COMMANDS } from '@mithic/coreutils';
import type { ProcessManager } from '@mithic/process/types';
import { Runtime } from '@mithic/shell';
import { getBashrc } from './bashrc.ts';

export function createTerminal(): Terminal {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    linkHandler: {
      activate(_event, uri) {
        const url = new URL(uri, location.href);
        if (url.origin === location.origin && url.searchParams.has('mode')) { location.href = uri; } else { window.open(uri, '_blank'); }
      },
    },
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

  return terminal;
}

export function createVfs(mode: string) {
  const memFs = new MemoryFsProvider();
  memFs.mkdir('/home');
  memFs.mkdir('/tmp');
  memFs.mkdir('/bin');

  for (const cmd of [...COREUTILS_COMMANDS, 'rust-component']) {
    const h = memFs.open(`/bin/${cmd}`, { create: true, write: true });
    memFs.close(h);
    memFs.chmod(`/bin/${cmd}`, 0o755);
  }

  const baseUrl = typeof location !== 'undefined' ? location.origin + location.pathname : undefined;
  const bashrcHandle = memFs.open('/home/.bashrc', { create: true, write: true });
  memFs.write(bashrcHandle, new TextEncoder().encode(getBashrc(mode, baseUrl)), 0);
  memFs.close(bashrcHandle);

  const vfs = new FileSystemRouter();
  return { memFs, vfs };
}

export async function mountVfs(vfs: FileSystemRouter, memFs: MemoryFsProvider) {
  await vfs.mount('/', memFs);
  await vfs.mount('/dev', new DeviceFsProvider());
}

export const ENV = { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color', PWD: '/home' };

export async function runShell(manager: ProcessManager): Promise<number> {
  const runtime = new Runtime({ manager, env: ENV, cwd: '/home' });
  const proc = runtime.exec('bash');
  const exitCode = await runtime.waitAsync(proc);
  runtime[Symbol.dispose]();
  return exitCode;
}
