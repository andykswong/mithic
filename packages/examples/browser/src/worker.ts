import { WASIShim } from '@mithic/wasip2';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/wasip2/io/streams';

const decoder = new TextDecoder();

/**
 * Blocking stdin for browser Web Workers.
 *
 * Uses SharedArrayBuffer + Atomics.wait to truly block the worker thread
 * until the main thread provides input data via Atomics.notify.
 *
 * Protocol:
 * - signal[0]: 0 = waiting, 1 = data ready, 2 = closed
 * - signal[1]: byte length of data written into dataBuffer
 * - dataBuffer: raw bytes written by main thread
 */
const STDIN_BUFFER_SIZE = 4096;
const stdinSignal = new SharedArrayBuffer(8); // [ready flag, data length]
const stdinData = new SharedArrayBuffer(STDIN_BUFFER_SIZE);
const signalView = new Int32Array(stdinSignal);
const dataView = new Uint8Array(stdinData);

// Send shared buffers to main thread so it can write stdin data
globalThis.postMessage({ type: 'stdin-init', signal: stdinSignal, data: stdinData });

const stdinHandler: InputStreamHandler = {
  read(len: number): Uint8Array | undefined {
    // Non-blocking: check if data is ready without waiting
    const ready = Atomics.load(signalView, 0);
    if (ready === 0) return undefined;
    if (ready === 2) throw { tag: 'closed' };
    return consumeStdinData(len);
  },
  blockingRead(len: number): Uint8Array {
    // Block until main thread signals data is available
    while (Atomics.load(signalView, 0) === 0) {
      Atomics.wait(signalView, 0, 0);
    }
    if (Atomics.load(signalView, 0) === 2) {
      throw { tag: 'closed' };
    }
    return consumeStdinData(len);
  },
};

function consumeStdinData(maxLen: number): Uint8Array {
  const byteLen = Atomics.load(signalView, 1);
  const readLen = Math.min(byteLen, maxLen);
  const result = new Uint8Array(readLen);
  result.set(dataView.subarray(0, readLen));
  // Reset signal — ready for next input
  Atomics.store(signalView, 0, 0);
  Atomics.store(signalView, 1, 0);
  return result;
}

const stdoutHandler: OutputStreamHandler = {
  checkWrite() { return 65536; },
  write(buf: Uint8Array) {
    globalThis.postMessage({ type: 'stdout', value: decoder.decode(buf) });
  },
  flush() {},
};

const stderrHandler: OutputStreamHandler = {
  checkWrite() { return 65536; },
  write(buf: Uint8Array) {
    globalThis.postMessage({ type: 'stderr', value: decoder.decode(buf) });
  },
  flush() {},
};

const shim = new WASIShim({
  sandbox: {
    args: ['mithic-cli'],
    env: { TEST: 'hello from browser' },
    stdin: stdinHandler,
    stdout: stdoutHandler,
    stderr: stderrHandler,
  }
});

// Load and run the WASM component
const { instantiate, modules } = await import('@mithic/example-rust-cli/component');
const { run } = await instantiate(
  async (path: keyof typeof modules) => modules[path] && WebAssembly.compile(await (await (await fetch(modules[path])).blob()).arrayBuffer()),
  shim.getImportObject()
);

run.run();
