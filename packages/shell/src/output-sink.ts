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
 * downstream cancelled (broken pipe) rejects the queued promise — swallowed here
 * so a producing builtin sees the stage end via its own EOF, not an unhandled
 * rejection; the pipeline's early-exit is driven by the downstream's cancel.
 */
export function sinkToStream(writable: WritableStream<Uint8Array>): { sink: OutputSink; close: () => Promise<void>; done: Promise<void> } {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let chain: Promise<void> = Promise.resolve();
  let broken = false;
  const push = (bytes: Uint8Array): void => {
    if (broken) return;
    chain = chain.then(() => writer.write(bytes)).catch(() => { broken = true; });
  };
  const sink: OutputSink = Object.assign((s: string) => push(encoder.encode(s)), {
    writeBytes: (b: Uint8Array) => push(b),
  });
  const close = async (): Promise<void> => {
    await chain;
    await writer.close().catch(() => { /* already closed / broken */ });
  };
  return { sink, close, done: chain };
}
