/**
 * `cat` — concatenate files (or stdin) to stdout.
 *
 * THE TEMPLATE for a coreutils command. A command file:
 *   1. imports the harness helpers it needs,
 *   2. defines a pure {@link import('../harness.ts').CommandFn} (`(io) => exitCode`),
 *   3. `export default defineCommand(catCommand);` to become a guest module.
 *
 * The repo's vite `preserveModules` build emits this 1:1 as `dist/commands/cat.js`,
 * which {@link import('../resolver.ts').createCoreutilsResolver} hands to the kernel
 * by URL. The kernel launches it as a sandboxed process; `createGuest` (inside
 * `defineCommand`) wires stdio and the `fs/*` syscalls.
 *
 * Supported:
 *   - operands: file paths to read in order; `-` (or none) reads stdin.
 *   - `-n` / `--number`: number all output lines, 1-based, right-aligned in 6.
 */
import { defineCommand, isBrokenPipe, parseArgs, writeBytes, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Read a whole VFS file via the kernel `fs/*` syscalls into bytes. */
async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/**
 * Stream a VFS file to `out` chunk-by-chunk (constant memory), stopping if the
 * downstream breaks (EPIPE). Returns true on a broken-pipe stop so the caller
 * can abort the rest. This lets `cat /dev/zero | head -c4` (a never-EOFing
 * device) terminate instead of buffering the device forever.
 */
async function streamFile(io: CommandIO, path: string, out: WritableStreamDefaultWriter<Uint8Array>): Promise<boolean> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      try { await writeBytes(out, chunk); }
      catch (e) { if (isBrokenPipe(e)) return true; throw e; }
    }
    return false;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

const catCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['n', 'number'],
    alias: { number: 'n' },
  });
  const number = Boolean(flags.n);
  const name = io.args[0] ?? 'cat';

  // No operands → read stdin once. `-` operands also mean stdin.
  const sources = positionals.length > 0 ? positionals : ['-'];

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let lineNo = 1;
  let stdinAborted = false;

  try {
    for (const src of sources) {
      if (src === '-') {
        if (!number) {
          // Raw byte passthrough — no line semantics needed.
          // Stream chunk-by-chunk so `cat bigfile | head -n1` can cancel early
          // instead of buffering all of bigfile first (D1).
          const reader = io.stdin.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;
              await writeBytes(out, value);
            }
          } catch (e) {
            if (isBrokenPipe(e)) { stdinAborted = true; }
            else throw e;
          } finally {
            reader.releaseLock();
          }
          continue;
        }
        // -n on stdin: buffer stdin fully to number lines (line semantics required).
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = io.stdin.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) { chunks.push(value); total += value.byteLength; }
          }
        } finally {
          reader.releaseLock();
        }
        const combined = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { combined.set(c, off); off += c.byteLength; }
        const bytes = combined;
        const text = new TextDecoder().decode(bytes);
        if (text === '') continue;
        const hasTrailing = text.endsWith('\n');
        const body = hasTrailing ? text.slice(0, -1) : text;
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const prefix = String(lineNo++).padStart(6, ' ') + '\t';
          const isLast = i === lines.length - 1;
          const suffix = !isLast || hasTrailing ? '\n' : '';
          await writeBytes(out, new TextEncoder().encode(prefix + lines[i] + suffix));
        }
        continue;
      }

      if (!number) {
        // Stream the file (constant memory) so a never-EOFing device or a huge
        // file does not buffer; stop early if the downstream breaks (EPIPE).
        try {
          if (await streamFile(io, src, out)) { stdinAborted = true; break; }
        } catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeLine(err, `${name}: ${src}: ${msg}`);
          exitCode = 1;
        }
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(io, src);
      } catch (e) {
        // Mirror coreutils: report per-file error, continue, exit non-zero.
        const msg = (e as { message?: string }).message ?? 'No such file or directory';
        await writeLine(err, `${name}: ${src}: ${msg}`);
        exitCode = 1;
        continue;
      }

      // -n: number every line. Split on \n, preserving a trailing newline.
      const text = new TextDecoder().decode(bytes);
      if (text === '') continue;
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const prefix = String(lineNo++).padStart(6, ' ') + '\t';
        const isLast = i === lines.length - 1;
        const suffix = !isLast || hasTrailing ? '\n' : '';
        await writeBytes(out, new TextEncoder().encode(prefix + lines[i] + suffix));
      }
    }
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }

  return exitCode;
};

export default defineCommand(catCommand);

// Exported for direct unit testing of the command logic without a kernel.
export { catCommand };
