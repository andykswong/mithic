/**
 * `yes` — repeatedly output a line with all specified STRINGs, or 'y'.
 *
 * Bounding & termination: `yes` is infinite by definition, but in a sandboxed
 * process stdout is a finite pipe backed by a credit-controlled WritableStream.
 * Two things make `yes | head -n3` terminate cleanly:
 *
 *   1. We write in LARGE batches (~64 KiB per `write()`), not one tiny line at a
 *      time. A per-line write parks on the pipe's flush timer (~one line per
 *      tick), so a head(1) downstream would take seconds to receive 3 lines and
 *      the producer would crawl. Batching means each `write()` carries real data
 *      and exercises genuine credit backpressure, so the whole pipeline drains
 *      and finishes in milliseconds.
 *   2. We stop the instant a `write()` rejects — that is the broken-pipe (EPIPE)
 *      signal raised when the downstream reader (e.g. head) closes/cancels its
 *      end. On that signal we exit 0, exactly like GNU `yes` piped to head.
 *
 * A MAX_BYTES safety cap also bounds a run with NO pipe consumer so it cannot
 * spin forever in an environment that never delivers a broken pipe.
 */
import { defineCommand, isBrokenPipe } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const BATCH_BYTES = 64 * 1024;
const MAX_BYTES = 64 * 1024 * 1024; // 64 MiB hard cap with no consumer

const yesCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const args = io.args.slice(1);
  const line = (args.length > 0 ? args.join(' ') : 'y') + '\n';
  const unit = new TextEncoder().encode(line);

  // Pre-build one ~BATCH_BYTES block of repeated lines so each write carries
  // many lines at once (see header note on flush-timer behavior).
  const perBatch = Math.max(1, Math.floor(BATCH_BYTES / unit.byteLength));
  const batch = new Uint8Array(perBatch * unit.byteLength);
  for (let i = 0; i < perBatch; i++) batch.set(unit, i * unit.byteLength);

  const out = io.stdout.getWriter();
  let written = 0;
  try {
    while (written < MAX_BYTES) {
      try {
        await out.write(batch);
      } catch (e) {
        // Broken pipe — downstream closed; stop cleanly.
        if (isBrokenPipe(e)) return 0;
        throw e;
      }
      written += batch.byteLength;
    }
  } finally {
    await out.close().catch(() => { /* already closed */ });
  }
  return 0;
};

export default defineCommand(yesCommand);
export { yesCommand };
