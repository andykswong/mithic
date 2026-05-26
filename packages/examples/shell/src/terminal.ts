/**
 * Terminal adapter — bridges xterm.js to the shell worker via SharedArrayBuffer.
 *
 * Protocol (main → worker stdin):
 * - signal[0]: 0 = waiting, 1 = data ready, 2 = closed
 * - signal[1]: byte length of data in dataBuffer
 * - dataBuffer: raw UTF-8 bytes
 *
 * Protocol (worker → main stdout/stderr):
 * - Worker posts { type: 'stdout' | 'stderr', value: string } messages
 */

import type { Terminal } from '@xterm/xterm';

const STDIN_BUFFER_SIZE = 4096;

export interface TerminalBridge {
  /** SharedArrayBuffer signal for stdin (Int32Array of length 2). */
  stdinSignal: SharedArrayBuffer;
  /** SharedArrayBuffer data buffer for stdin bytes. */
  stdinData: SharedArrayBuffer;
  /** Write output text to the terminal. */
  writeToTerminal(text: string): void;
}

export function createTerminalBridge(terminal: Terminal, worker: Worker): TerminalBridge {
  const stdinSignal = new SharedArrayBuffer(8);
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
        // Ctrl+C — send empty line to unblock, then reset
        terminal.write('^C\r\n');
        lineBuffer = '';
        sendLine('\n');
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

  function writeToTerminal(text: string): void {
    // Normalize newlines for xterm
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
