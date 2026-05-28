import type { Terminal } from '@xterm/xterm';

const STDIN_BUFFER_SIZE = 4096;

export interface TerminalBridge {
  stdinSignal: SharedArrayBuffer;
  stdinData: SharedArrayBuffer;
  writeToTerminal(text: string): void;
}

export function createTerminalBridge(terminal: Terminal, worker: Worker): TerminalBridge {
  const stdinSignal = new SharedArrayBuffer(12);
  const stdinData = new SharedArrayBuffer(STDIN_BUFFER_SIZE);
  const signalView = new Int32Array(stdinSignal);

  const encoder = new TextEncoder();
  const dataView = new Uint8Array(stdinData);

  let lineBuffer = '';

  terminal.onData((data) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        terminal.write('\r\n');
        sendLine(lineBuffer + '\n');
        lineBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (lineBuffer.length > 0) {
          lineBuffer = lineBuffer.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (ch === '\x03') {
        terminal.write('^C\r\n');
        lineBuffer = '';
        sendSignal(2);
      } else if (ch === '\x1a') {
        terminal.write('^Z\r\n');
        lineBuffer = '';
        sendSignal(20);
      } else {
        lineBuffer += ch;
        terminal.write(ch);
      }
    }
  });

  function sendLine(line: string): void {
    const bytes = encoder.encode(line);
    const writeLen = Math.min(bytes.byteLength, STDIN_BUFFER_SIZE);
    dataView.set(bytes.subarray(0, writeLen));
    Atomics.store(signalView, 1, writeLen);
    Atomics.store(signalView, 0, 1);
    Atomics.notify(signalView, 0);
  }

  function sendSignal(sigNum: number): void {
    Atomics.store(signalView, 2, sigNum);
    Atomics.store(signalView, 0, 1);
    Atomics.notify(signalView, 0);
  }

  function writeToTerminal(text: string): void {
    terminal.write(text.replace(/\n/g, '\r\n'));
  }

  worker.onmessage = (e: MessageEvent) => {
    if (e.data?.type === 'stdout' || e.data?.type === 'stderr') {
      writeToTerminal(e.data.value);
    } else if (e.data?.type === 'prompt') {
      terminal.write(e.data.value);
    }
  };

  return { stdinSignal, stdinData, writeToTerminal };
}
