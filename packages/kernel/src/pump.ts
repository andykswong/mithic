import { PipeWriter } from '@mithic/protocol';

/**
 * Return `view` if it already spans its entire backing buffer; otherwise copy
 * into a fresh tight `Uint8Array`. This ensures the caller can safely transfer
 * `.buffer` over `postMessage` without clobbering pooled buffers or sending
 * wrong bytes when `byteOffset > 0`.
 */
function toTightView(view: Uint8Array): Uint8Array {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view;
  return new Uint8Array(view);
}

/**
 * Drive bytes from `next()` into a pipe WRITE port honoring the credit protocol,
 * then send EOF + close. Shared by fd-wiring's file/bytes stdin pumps and the
 * net/fetch response-body pump.
 *
 * `next()` returns the next source chunk (any size) or `null` at EOF; a
 * zero-length chunk is skipped. The shared {@link PipeWriter} owns credit
 * accounting + the STICKY broken latch: a `credit` message grants credit, an
 * `end`/`error` message marks the pipe broken so a parked `reserve()` rejects
 * promptly (the reader cancelled / EPIPE).
 *
 * R2: a source chunk can exceed the reader's credit WINDOW (`windowBytes`). A
 * `reserve()` for a whole >window chunk can NEVER be satisfied — the reader
 * cannot grant more than its window — so it would park forever and the pump
 * would HANG. Each source chunk is therefore SPLIT into sub-chunks of at most
 * `windowBytes` before reserving, so the pump never reserves more than any
 * reader's window can grant. Each sub-chunk still flows through `reserve()`, so
 * credit-based back-pressure (a slow consumer stalling the pump) is preserved —
 * the per-reserve size is capped, not the total.
 *
 * Returns `true` if the loop ended because the pipe broke or a read/transfer
 * failed (so the caller can cancel an unbounded source), `false` on clean EOF.
 * Source teardown (closing a VFS handle, cancelling a stream) is the caller's
 * responsibility.
 */
export async function pumpToPort(
  writePort: MessagePort,
  next: () => Promise<Uint8Array | null>,
  windowBytes: number,
): Promise<boolean> {
  writePort.start?.();
  const flow = new PipeWriter();
  writePort.onmessage = (e: MessageEvent): void => {
    const msg = e.data as { type?: string; bytes?: number };
    if (msg?.type === 'credit') flow.addCredit(msg.bytes ?? 0);
    else if (msg?.type === 'end' || msg?.type === 'error') flow.markBroken('EPIPE');
  };
  let broken = false;
  try {
    for (;;) {
      const value = await next();
      if (value === null) break; // EOF
      if (value.byteLength === 0) continue;
      // R2: never reserve more than the reader's window in one go (it can never
      // grant more), or the pump deadlocks. Split a large chunk into window-sized
      // sub-chunks; each is reserved + posted independently so a >window chunk
      // flows over a small window with full back-pressure preserved.
      for (let off = 0; off < value.byteLength; off += windowBytes) {
        const sub = toTightView(value.subarray(off, off + windowBytes));
        // reserve() rejects if the pipe is broken (reader cancelled / EPIPE),
        // ending the pump so the caller can cancel an unbounded source.
        await flow.reserve(sub.byteLength);
        writePort.postMessage({ type: 'data', chunk: sub }, [sub.buffer as ArrayBuffer]);
      }
    }
  } catch {
    // A broken pipe (or read/transfer failure): stop pumping; fall through to
    // EOF/close and report broken so the caller can cancel its source.
    broken = true;
  }
  try { writePort.postMessage({ type: 'end' }); } catch { /* closed */ }
  try { writePort.close(); } catch { /* closed */ }
  return broken;
}
