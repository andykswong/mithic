/**
 * Implements wasi:cli/stdin, wasi:cli/stdout, wasi:cli/stderr.
 */

import { InputStream, OutputStream, type InputStreamHandler, type OutputStreamHandler } from '../io/streams.ts';
import type { Pollable } from '../io/poll.ts';

export interface InputStdioConfig {
  handler: InputStreamHandler;
  subscribe?: () => Pollable;
  isatty?: boolean;
}

export interface OutputStdioConfig {
  handler: OutputStreamHandler;
  subscribe?: () => Pollable;
  isatty?: boolean;
}

const textDecoder = new TextDecoder();

// ─── Default handlers ───────────────────────────────────────────────────────

const defaultStdinHandler: InputStreamHandler = {
  read(_len: number): Uint8Array | undefined {
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
      data = data.subarray(0, data.length - 1);
    }
    console.error(textDecoder.decode(data));
  },
  flush(): void {},
};

// ─── Singletons ─────────────────────────────────────────────────────────────

let stdinStream = new InputStream(defaultStdinHandler);
let stdoutStream = new OutputStream(defaultStdoutHandler);
let stderrStream = new OutputStream(defaultStderrHandler);

// ─── Public API ─────────────────────────────────────────────────────────────

// Return a borrow each call so WASM resource drops don't dispose the owned singleton.
export function getStdin(): InputStream {
  return stdinStream.borrow();
}

export function getStdout(): OutputStream {
  return stdoutStream.borrow();
}

export function getStderr(): OutputStream {
  return stderrStream.borrow();
}

export function _setStdin(config: InputStream | InputStreamHandler | InputStdioConfig): void {
  stdinStream[Symbol.dispose]();
  if (config instanceof InputStream) {
    stdinStream = config;
  } else if ('handler' in config) {
    stdinStream = new InputStream(config.handler, config.subscribe, config.isatty);
  } else {
    stdinStream = new InputStream(config as InputStreamHandler);
  }
}

export function _setStdout(config: OutputStream | OutputStreamHandler | OutputStdioConfig): void {
  stdoutStream[Symbol.dispose]();
  if (config instanceof OutputStream) {
    stdoutStream = config;
  } else if ('handler' in config) {
    stdoutStream = new OutputStream(config.handler, config.subscribe, config.isatty);
  } else {
    stdoutStream = new OutputStream(config as OutputStreamHandler);
  }
}

export function _setStderr(config: OutputStream | OutputStreamHandler | OutputStdioConfig): void {
  stderrStream[Symbol.dispose]();
  if (config instanceof OutputStream) {
    stderrStream = config;
  } else if ('handler' in config) {
    stderrStream = new OutputStream(config.handler, config.subscribe, config.isatty);
  } else {
    stderrStream = new OutputStream(config as OutputStreamHandler);
  }
}

export const stdin = { InputStream, getStdin };
export const stdout = { OutputStream, getStdout };
export const stderr = { OutputStream, getStderr };
