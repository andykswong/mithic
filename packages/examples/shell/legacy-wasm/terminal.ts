import type { Terminal } from '@xterm/xterm';
import type { InputStreamHandler, OutputStreamHandler, SyncOutputStreamHandler } from '@mithic/io/io';

export interface TerminalStdio {
  stdin: InputStreamHandler;
  stdout: OutputStreamHandler & SyncOutputStreamHandler;
  stderr: OutputStreamHandler & SyncOutputStreamHandler;
}

export function createTerminalStdio(terminal: Terminal): TerminalStdio {
  const encoder = new TextEncoder();

  let buffer: Uint8Array = new Uint8Array(0);
  let waiting: ((chunk: Uint8Array) => void) | null = null;

  terminal.onData((data) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        terminal.write('\r\n');
        pushInput(encoder.encode(lineBuffer + '\n'));
        lineBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (lineBuffer.length > 0) {
          lineBuffer = lineBuffer.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (ch === '\x03') {
        terminal.write('^C\r\n');
        lineBuffer = '';
        pushInput(encoder.encode('\n'));
      } else if (ch === '\x1a') {
        terminal.write('^Z\r\n');
        lineBuffer = '';
        pushInput(encoder.encode('\n'));
      } else {
        lineBuffer += ch;
        terminal.write(ch);
      }
    }
  });

  let lineBuffer = '';

  function pushInput(data: Uint8Array): void {
    if (waiting) {
      const cb = waiting;
      waiting = null;
      cb(data);
    } else {
      const merged = new Uint8Array(buffer.length + data.length);
      merged.set(buffer);
      merged.set(data, buffer.length);
      buffer = merged;
    }
  }

  function writeToTerminal(data: Uint8Array): void {
    const text = new TextDecoder().decode(data);
    terminal.write(text.replace(/\n/g, '\r\n'));
  }

  const stdin: InputStreamHandler = {
    read(len: number): Uint8Array | undefined {
      if (buffer.length > 0) {
        const chunk = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        return new Uint8Array(chunk);
      }
      return undefined;
    },
    blockingRead(len: number): Promise<Uint8Array> {
      if (buffer.length > 0) {
        const chunk = buffer.subarray(0, len);
        buffer = buffer.subarray(len);
        return Promise.resolve(new Uint8Array(chunk));
      }
      return new Promise((resolve) => {
        waiting = (chunk) => {
          buffer = chunk;
          const result = buffer.subarray(0, len);
          buffer = buffer.subarray(len);
          resolve(new Uint8Array(result));
        };
      });
    },
  };

  const stdout: OutputStreamHandler & SyncOutputStreamHandler = {
    write(data: Uint8Array): void { writeToTerminal(data); },
  };

  const stderr: OutputStreamHandler & SyncOutputStreamHandler = {
    write(data: Uint8Array): void { writeToTerminal(data); },
  };

  return { stdin, stdout, stderr };
}
