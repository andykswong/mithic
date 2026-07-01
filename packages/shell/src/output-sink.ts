/**
 * The shell's output sink. Callable as `sink(text)` (the legacy string path used
 * by ~all builtins and executor writes) AND `sink.writeBytes(bytes)` for raw,
 * binary-safe output (a guest's stdout passed through without a UTF-8 round-trip).
 */
export interface OutputSink {
  (s: string): void;
  writeBytes(b: Uint8Array): void;
}

const TEXT_DECODER = new TextDecoder();

/**
 * Normalize a sink argument into a full {@link OutputSink}. An existing sink
 * (already has `writeBytes`) is returned unchanged. A bare `(s: string) => void`
 * (tests, a text-only terminal) is wrapped: its `writeBytes` UTF-8-decodes to
 * text — lossy for true binary, but such sinks never carried binary anyway.
 */
export function toSink(fn: OutputSink | ((s: string) => void)): OutputSink {
  if ('writeBytes' in fn && typeof (fn as OutputSink).writeBytes === 'function') return fn as OutputSink;
  return Object.assign((s: string) => (fn as (s: string) => void)(s), {
    writeBytes: (b: Uint8Array) => (fn as (s: string) => void)(TEXT_DECODER.decode(b)),
  });
}
