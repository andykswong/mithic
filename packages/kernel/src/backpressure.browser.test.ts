/**
 * Group K.2 — pipe backpressure under load, real transfer path (browser).
 *
 * A producer writes 5MB in 64KB chunks into a zero-hop kernel pipe whose other
 * end is a SLOW consumer (reads with a delay). The producer observes its own
 * WritableStream writer `desiredSize`; with working credit-based flow control it
 * must go ≤ 0 (credit exhausted) before the consumer has drained everything.
 * The consumer counts bytes and must receive exactly 5MB.
 *
 * Runs in an opaque-origin sandboxed iframe (IframeRuntime), so the guest cannot
 * import @mithic/guest-runtime — the credit-windowed stream helpers are inlined
 * (mirrors @mithic/guest-runtime/streams, including the sliding-window reader
 * that is the actual backpressure mechanism).
 *
 * Reporting (out of the data path):
 *   - Producer writes a one-line JSON report to STDERR (kernel-captured) with the
 *     minimum desiredSize it observed and whether it saw backpressure.
 *   - Consumer writes the total byte count it received to STDOUT (kernel-captured).
 */
import { expect, test } from 'vitest';
import { Kernel } from './kernel.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/**
 * Inline guest runtime for the opaque-origin iframe. Mirrors
 * @mithic/guest-runtime/streams: credit-gated writer + sliding-window reader.
 */
const INLINE_GUEST_RUNTIME = /* js */ `
const INITIAL_CREDIT_BYTES = 64 * 1024;
const PIPE_FLUSH_BYTES = 16 * 1024;
const PIPE_FLUSH_MS = 4;
const TRANSFER_THRESHOLD_BYTES = 10 * 1024;

function portToWritable(port) {
  port.start?.();
  let credit = 0;
  const creditWaiters = [];
  port.onmessage = (e) => {
    const msg = e.data;
    if (msg && msg.type === 'credit') {
      credit += msg.bytes;
      while (creditWaiters.length > 0 && credit >= creditWaiters[0].needed) {
        creditWaiters.shift().resolve();
      }
    }
  };
  let buf = [], bufSize = 0, flushTimer = null;
  function flushNow() {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (buf.length === 0) return Promise.resolve();
    const chunks = buf; buf = []; bufSize = 0;
    return (async () => {
      for (const chunk of chunks) {
        if (credit < chunk.byteLength) {
          await new Promise(resolve => creditWaiters.push({ needed: chunk.byteLength, resolve }));
        }
        credit -= chunk.byteLength;
        const transfer = chunk.byteLength >= TRANSFER_THRESHOLD_BYTES ? [chunk.buffer] : [];
        port.postMessage({ type: 'data', chunk }, transfer);
      }
    })();
  }
  return new WritableStream({
    write(chunk) {
      buf.push(chunk); bufSize += chunk.byteLength;
      if (bufSize >= PIPE_FLUSH_BYTES) return flushNow();
      if (flushTimer === null) return new Promise(resolve => { flushTimer = setTimeout(() => flushNow().then(resolve), PIPE_FLUSH_MS); });
      return Promise.resolve();
    },
    close() { return flushNow().then(() => { port.postMessage({ type: 'end' }); port.close(); }); },
    abort() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); },
  });
}

function portToReadable(port) {
  port.start?.();
  let controller = null;
  const window = INITIAL_CREDIT_BYTES;
  let outstanding = 0, consumedUncredited = 0, opened = false;
  function grant(bytes) { if (bytes <= 0) return; outstanding += bytes; port.postMessage({ type: 'credit', bytes }); }
  return new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      port.onmessage = (e) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'data') { outstanding -= msg.chunk.byteLength; consumedUncredited += msg.chunk.byteLength; controller.enqueue(msg.chunk); }
        else if (msg.type === 'end') { controller.close(); port.close(); }
        else if (msg.type === 'error') { controller.error(new Error(msg.code)); port.close(); }
      };
    },
    pull() {
      if (!opened) { opened = true; consumedUncredited = 0; grant(window); return; }
      const room = window - outstanding;
      const replenish = Math.min(consumedUncredited, room);
      consumedUncredited -= replenish;
      grant(replenish);
    },
    cancel() { port.postMessage({ type: 'error', code: 'EPIPE' }); port.close(); },
  });
}

function createGuest({ control, init, preopenPorts = {} }) {
  const responseListeners = [];
  control.start?.();
  control.onmessage = (e) => { for (const cb of responseListeners) cb(e.data); };
  const stdinPort = preopenPorts[0];
  const stdoutPort = preopenPorts[1];
  const stderrPort = preopenPorts[2];
  const stdin = stdinPort ? portToReadable(stdinPort) : new ReadableStream();
  const stdout = stdoutPort ? portToWritable(stdoutPort) : new WritableStream();
  const stderr = stderrPort ? portToWritable(stderrPort) : new WritableStream();
  return {
    pid: init.pid, args: init.args, env: init.env, cwd: init.cwd,
    stdin, stdout, stderr,
    exit(code) { control.postMessage({ type: 'exit', code }); control.close(); },
  };
}
`;

test('pipe backpressure: 5MB producer → slow consumer engages flow control', async () => {
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new IframeRuntime(), vfs });

  const TOTAL = 5 * 1024 * 1024;
  const CHUNK = 64 * 1024;

  const producer = INLINE_GUEST_RUNTIME + `
    export default async (boot) => {
      const g = createGuest(boot);
      const w = g.stdout.getWriter();
      const total = ${TOTAL}, chunk = ${CHUNK};
      let minDesiredSize = Infinity, sawBackpressure = false;
      const n = total / chunk;
      for (let i = 0; i < n; i++) {
        const ds = w.desiredSize ?? 0;
        if (ds < minDesiredSize) minDesiredSize = ds;
        if (ds <= 0) sawBackpressure = true;
        w.write(new Uint8Array(chunk));
        const ds2 = w.desiredSize ?? 0;
        if (ds2 < minDesiredSize) minDesiredSize = ds2;
        if (ds2 <= 0) sawBackpressure = true;
        await w.ready;
      }
      await w.close();
      const report = JSON.stringify({ minDesiredSize, sawBackpressure });
      const ew = g.stderr.getWriter();
      await ew.write(new TextEncoder().encode(report));
      await ew.close();
      g.exit(0);
    };
  `;

  const consumer = INLINE_GUEST_RUNTIME + `
    export default async (boot) => {
      const g = createGuest(boot);
      const rd = g.stdin.getReader();
      let received = 0;
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        received += value.byteLength;
        await new Promise(r => setTimeout(r, 1)); // slow drain
      }
      const w = g.stdout.getWriter();
      await w.write(new TextEncoder().encode(String(received)));
      await w.close();
      g.exit(0);
    };
  `;

  const result = await kernel.runPipeline([
    { code: producer, args: ['producer'], captureStderr: true },
    { code: consumer, args: ['consumer'], captureStdout: true },
  ]);

  expect(result.exitCodes).toEqual([0, 0]);

  const received = Number(new TextDecoder().decode(await result.lastStdout));
  expect(received).toBe(TOTAL);

  const report = JSON.parse(new TextDecoder().decode(await result.stderr[0]!)) as {
    minDesiredSize: number;
    sawBackpressure: boolean;
  };
  // The producer must have stalled on credit: desiredSize ≤ 0 at some point.
  expect(report.sawBackpressure).toBe(true);
  expect(report.minDesiredSize).toBeLessThanOrEqual(0);
}, 60000);
