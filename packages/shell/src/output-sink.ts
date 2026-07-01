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
