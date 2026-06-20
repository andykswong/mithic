/**
 * `tee` — read stdin and write to stdout AND to each file operand.
 *
 * Supported:
 *   - file operands written via `fs/*` syscalls (open create+truncate, or append).
 *   - `-a` / `--append`: append to files instead of truncating.
 *   - always copies stdin to stdout.
 *
 * Streaming (parity finding M22): tee writes EACH chunk to stdout and to every
 * file AS IT ARRIVES, rather than buffering all of stdin first. This lets tee
 * sit in an unbounded pipeline and keeps stdout passthrough in input order (not
 * reordered after the file writes). Files are opened once up front and the
 * per-file write offset is tracked across chunks.
 *
 * Requires write capability for the target paths.
 */
import { defineCommand, parseArgs, writeBytes, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

interface Sink { path: string; fd: number; offset: number; append: boolean; }

const teeCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['a', 'append'],
    alias: { append: 'a' },
  });
  const name = io.args[0] ?? 'tee';
  const append = Boolean(flags.a);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  // Open all file sinks up front; a sink that fails to open is reported and
  // dropped (tee continues to the rest, GNU-style).
  const sinks: Sink[] = [];
  for (const path of positionals) {
    try {
      const oflags = append
        ? { create: true, write: true, append: true }
        : { create: true, write: true, truncate: true };
      const { fd } = (await io.syscall('fs/open', { path, oflags })) as { fd: number };
      sinks.push({ path, fd, offset: 0, append });
    } catch (e) {
      const msg = (e as { message?: string }).message ?? 'cannot write';
      await writeString(err, `${name}: ${path}: ${msg}\n`);
      exitCode = 1;
    }
  }

  const reader = io.stdin.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      // stdout first (passthrough order), then each file at its tracked offset.
      await writeBytes(out, value);
      for (const s of sinks) {
        try {
          if (s.append) await io.syscall('fs/write', { fd: s.fd, data: value });
          else { await io.syscall('fs/write', { fd: s.fd, data: value, offset: s.offset }); }
          s.offset += value.byteLength;
        } catch (e) {
          const msg = (e as { message?: string }).message ?? 'cannot write';
          await writeString(err, `${name}: ${s.path}: ${msg}\n`);
          exitCode = 1;
        }
      }
    }
    return exitCode;
  } finally {
    reader.releaseLock();
    for (const s of sinks) await io.syscall('fs/close', { fd: s.fd }).catch(() => {});
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(teeCommand);
export { teeCommand };
