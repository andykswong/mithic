/**
 * `yes` — repeatedly output a line with all specified STRINGs, or 'y'.
 *
 * Bounding: `yes` is infinite by definition, but in a sandboxed process stdout
 * is a finite pipe backed by a WritableStream. We detect a broken pipe by
 * catching the rejection from `writer.write()` (which rejects with a
 * "TypeError: WritableStream is closed" or similar when the downstream reader
 * closes). On that signal we stop immediately and exit 0 — exactly the
 * behavior of GNU coreutils `yes` when piped to a head(1).
 *
 * As an additional safety cap, we also stop after MAX_LINES iterations so a
 * run in an environment with no pipe consumer cannot spin forever.
 */
import { defineCommand } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const MAX_LINES = 10_000;

const yesCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const args = io.args.slice(1);
  const line = (args.length > 0 ? args.join(' ') : 'y') + '\n';
  const bytes = new TextEncoder().encode(line);

  const out = io.stdout.getWriter();
  try {
    for (let i = 0; i < MAX_LINES; i++) {
      try {
        await out.write(bytes);
      } catch {
        // Broken pipe — downstream closed; stop cleanly.
        return 0;
      }
    }
  } finally {
    await out.close().catch(() => { /* already closed */ });
  }
  return 0;
};

export default defineCommand(yesCommand);
export { yesCommand };
