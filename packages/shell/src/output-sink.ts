/**
 * The shell's output sink. Callable as `sink(text)` (the legacy string path used
 * by ~all builtins and executor writes) AND `sink.writeBytes(bytes)` for raw,
 * binary-safe output (a guest's stdout passed through without a UTF-8 round-trip).
 */
export interface OutputSink {
  (s: string): void;
  writeBytes(b: Uint8Array): void;
}

/**
 * The SIGPIPE-equivalent unwind. Thrown SYNCHRONOUSLY by a broken {@link sinkToStream}
 * sink's `write`/`writeBytes` so an in-process BUILTIN producer (e.g. `echo` inside
 * `while :; do echo x; done | head`) is torn down the moment the downstream stage
 * closes — mirroring bash killing the producer with SIGPIPE (exit 128 + 13 = 141).
 * Defined here, in the lower module, so `sinkToStream` can throw it without importing
 * the executor (no circular dependency); the pipeline stage boundary catches it.
 */
export class BrokenPipeError extends Error {
  /** 128 + SIGPIPE(13). */
  readonly code = 141;
  constructor() {
    super('broken pipe');
    this.name = 'BrokenPipeError';
  }
}

/**
 * Normalize a sink argument into a full {@link OutputSink}. An existing sink
 * (already has `writeBytes`) is returned unchanged. A bare `(s: string) => void`
 * (tests, a text-only terminal) is wrapped: its `writeBytes` UTF-8-decodes to
 * text — lossy for true binary, but such sinks never carried binary anyway.
 *
 * The wrapper owns a per-instance STREAMING decoder so a multi-byte char split
 * across two `writeBytes` chunks (e.g. on a pipe credit-window boundary)
 * reassembles correctly rather than emitting a replacement char per fragment.
 */
export function toSink(fn: OutputSink | ((s: string) => void)): OutputSink {
  if ('writeBytes' in fn && typeof (fn as OutputSink).writeBytes === 'function') return fn as OutputSink;
  const text = fn as (s: string) => void;
  const dec = new TextDecoder();
  return Object.assign((s: string) => text(s), {
    writeBytes: (b: Uint8Array) => text(dec.decode(b, { stream: true })),
  });
}

/**
 * Adapt a {@link WritableStream}<Uint8Array> into an {@link OutputSink} for a
 * pipeline stage's stdout: `write(text)` UTF-8-encodes, `writeBytes(bytes)` passes
 * raw. Writes are queued through a single writer (ordering preserved). `close()`
 * flushes + closes the writer (EOF to the downstream stage). A write after the
 * downstream cancelled (broken pipe) rejects the queued promise — latched into
 * `broken`. Once broken, any SUBSEQUENT synchronous `write`/`writeBytes` THROWS
 * {@link BrokenPipeError} (SIGPIPE-equivalent) so an in-process builtin producer is
 * unwound at the point of its next write rather than spinning forever; the pipeline
 * stage boundary catches it and records exit 141. `isBroken()` exposes the latch
 * synchronously for callers that want to poll rather than write-and-catch.
 */
export function sinkToStream(writable: WritableStream<Uint8Array>): { sink: OutputSink; close: () => Promise<void>; done: Promise<void>; isBroken: () => boolean; abort: () => void } {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let chain: Promise<void> = Promise.resolve();
  let broken = false;
  const push = (bytes: Uint8Array): void => {
    // Already known-broken: unwind the writer (SIGPIPE-equivalent) instead of
    // silently dropping the byte and letting the producer loop spin on.
    if (broken) throw new BrokenPipeError();
    chain = chain.then(() => writer.write(bytes)).catch(() => { broken = true; });
  };
  const sink: OutputSink = Object.assign((s: string) => push(encoder.encode(s)), {
    writeBytes: (b: Uint8Array) => push(b),
  });
  const close = async (): Promise<void> => {
    if (broken) { await writer.close().catch(() => {}); return; }
    await chain;
    await writer.close().catch(() => { /* already closed / broken */ });
  };
  // Forcibly break the writer: reject any queued/pending writes and error the
  // stream. Used when this producer's DOWNSTREAM went away without cancelling our
  // readable (a middle stage whose consumer exited early leaves our reader locked-
  // but-abandoned, so a backpressured `writer.write()` would otherwise hang forever
  // and strand `close()`'s `await chain`). Aborting rejects those writes → `broken`
  // latches → the next producer `write` throws {@link BrokenPipeError}.
  const abort = (): void => {
    broken = true;
    writer.abort().catch(() => { /* already closed / errored */ });
  };
  return { sink, close, done: chain, isBroken: () => broken, abort };
}
