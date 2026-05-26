import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createTerminalBridge } from './terminal.ts';

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

// Launch shell worker
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const bridge = createTerminalBridge(terminal, worker);

// Send SAB handles to worker
worker.postMessage({ type: 'init', signal: bridge.stdinSignal, data: bridge.stdinData });
