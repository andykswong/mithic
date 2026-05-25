/**
 * Implements wasi:cli/stdin, wasi:cli/stdout, wasi:cli/stderr.
 */

import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from '../io/streams.ts';

const textDecoder = new TextDecoder();

// ─── Default handlers ───────────────────────────────────────────────────────

const defaultStdinHandler: InputStreamHandler = {
  read(_len: number): Uint8Array | undefined {
    // No stdin available in default mode
    return undefined;
  },
  blockingRead(_len: number): Uint8Array {
    throw { tag: 'closed' };
  },
};

const defaultStdoutHandler: OutputStreamHandler = {
  write(contents: Uint8Array): void {
    let data = contents;
    if (data.length > 0 && data[data.length - 1] === 10) {
      // console.log already appends a newline
      data = data.subarray(0, data.length - 1);
    }
    console.log(textDecoder.decode(data));
  },
  flush(): void {},
};

const defaultStderrHandler: OutputStreamHandler = {
  write(contents: Uint8Array): void {
    let data = contents;
    if (data.length > 0 && data[data.length - 1] === 10) {
      // console.error already appends a newline
      data = data.subarray(0, data.length - 1);
    }
    console.error(textDecoder.decode(data));
  },
  flush(): void {},
};

// ─── Stream instances ───────────────────────────────────────────────────────

let stdinStream = new InputStream(defaultStdinHandler);
let stdoutStream = new OutputStream(defaultStdoutHandler);
let stderrStream = new OutputStream(defaultStderrHandler);

// ─── Public API ─────────────────────────────────────────────────────────────

export function getStdin(): InputStream {
  return stdinStream;
}

export function getStdout(): OutputStream {
  return stdoutStream;
}

export function getStderr(): OutputStream {
  return stderrStream;
}

export function _setStdin(handler: InputStreamHandler): void {
  stdinStream = new InputStream(handler);
}

export function _setStdout(handler: OutputStreamHandler): void {
  stdoutStream = new OutputStream(handler);
}

export function _setStderr(handler: OutputStreamHandler): void {
  stderrStream = new OutputStream(handler);
}

export const stdin = { InputStream, getStdin };
export const stdout = { OutputStream, getStdout };
export const stderr = { OutputStream, getStderr };
