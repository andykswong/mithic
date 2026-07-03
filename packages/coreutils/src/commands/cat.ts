/**
 * `cat` — concatenate files (or stdin) to stdout.
 *
 * THE TEMPLATE for a coreutils command. A command file:
 *   1. imports the harness helpers it needs,
 *   2. defines a pure {@link import('../harness.ts').CommandFn} (`(io) => exitCode`),
 *   3. `export default defineCommand(catCommand);` to become a guest module.
 *
 * Supported (GNU parity):
 *   - operands: file paths to read in order; `-` (or none) reads stdin.
 *   - `-n` / `--number`: number all output lines; `-b` / `--number-nonblank`
 *     numbers only non-empty lines (and overrides `-n`).
 *   - `-s` / `--squeeze-blank`: collapse runs of blank lines.
 *   - `-E` / `--show-ends` (`$` at line ends), `-T` / `--show-tabs` (`^I`),
 *     `-v` / `--show-nonprinting` (`^X` / `M-` forms); `-A`=`-vET`, `-e`=`-vE`,
 *     `-t`=`-vT`.
 *
 * With no formatting flag, stdin/files stream byte-exact (constant memory).
 */
import { defineCommand, exitWith, fsErrorText, isBrokenPipe, optionError, parseArgs, writeBytes, writeLine } from '../harness.ts';
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

/**
 * Canonical POSIX errno text for an `fs/*` failure. Over the real kernel the
 * FileSystemError is re-serialized with a POSIX errno `code` (e.g. `ENOENT`) and
 * a provider-specific message (`File not found: …`); {@link fsErrorText} only maps
 * the VFS codes, so we translate the errno here first and fall back to it for the
 * VFS-code path used by the in-memory unit tests.
 */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EXDEV: 'Invalid cross-device link',
  ENOTEMPTY: 'Directory not empty',
  EINVAL: 'Invalid argument',
  ENOSPC: 'No space left on device',
  EIO: 'Input/output error',
};
function errnoText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  return (code && ERRNO_TEXT[code]) ?? fsErrorText(err);
}

interface Options { number: boolean; numberNonblank: boolean; squeeze: boolean; showEnds: boolean; showTabs: boolean; showNonprint: boolean; }

/** Render one non-newline byte under `-v`/`-T` (show-nonprinting / show-tabs). */
function renderByte(b: number, opts: Options, out: number[]): void {
  if (b === 0x09) { // tab
    if (opts.showTabs) { out.push(0x5e, 0x49); } else { out.push(0x09); } // ^I
    return;
  }
  if (!opts.showNonprint) { out.push(b); return; }
  let v = b;
  if (v >= 128) { out.push(0x4d, 0x2d); v -= 128; } // M-
  if (v < 32) { out.push(0x5e, v + 64); } // ^X
  else if (v === 127) { out.push(0x5e, 0x3f); } // ^?
  else out.push(v);
}

/**
 * Apply cat's formatting flags to `bytes`, threading line-numbering and
 * blank-squeeze state via `state` across files. Returns the transformed bytes.
 */
function formatBytes(bytes: Uint8Array, opts: Options, state: { lineNo: number; blanks: number }): Uint8Array {
  const out: number[] = [];
  const doNumber = opts.number || opts.numberNonblank;
  const encNum = (n: number): number[] => {
    const s = String(n).padStart(6, ' ') + '\t';
    return [...s].map((c) => c.charCodeAt(0));
  };
  let i = 0;
  while (i < bytes.length) {
    // Determine the current logical line (up to and including the next \n).
    let nl = i;
    while (nl < bytes.length && bytes[nl] !== 0x0a) nl++;
    const hasNL = nl < bytes.length;
    const isBlank = nl === i; // empty line (immediate newline)

    if (opts.squeeze && isBlank) {
      state.blanks++;
      if (state.blanks > 1) { i = hasNL ? nl + 1 : nl; continue; } // drop extra blank
    } else if (!isBlank) {
      state.blanks = 0;
    }

    // Line number prefix: -n numbers all lines; -b only non-blank.
    if (doNumber) {
      if (opts.numberNonblank) { if (!isBlank) out.push(...encNum(state.lineNo++)); }
      else out.push(...encNum(state.lineNo++));
    }
    for (let j = i; j < nl; j++) renderByte(bytes[j], opts, out);
    if (hasNL) {
      if (opts.showEnds) out.push(0x24); // $
      out.push(0x0a);
      i = nl + 1;
    } else {
      i = nl; // unterminated final line: no $ / no newline
    }
  }
  return new Uint8Array(out);
}

const catCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    boolean: [
      'n', 'number', 'b', 'number-nonblank', 's', 'squeeze-blank',
      'E', 'show-ends', 'T', 'show-tabs', 'v', 'show-nonprinting',
      'A', 'show-all', 'e', 't', 'u',
    ],
    alias: {
      number: 'n', 'number-nonblank': 'b', 'squeeze-blank': 's',
      'show-ends': 'E', 'show-tabs': 'T', 'show-nonprinting': 'v', 'show-all': 'A',
    },
    unknown: 'error',
  });
  const name = io.args[0] ?? 'cat';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  if (parsed.unknown.length) {
    try { return await exitWith(err, 1, optionError(name, parsed.unknown[0])); }
    finally { await out.close().catch(() => {}); await err.close().catch(() => {}); }
  }

  const { positionals, flags } = parsed;
  // Composite flags: -A = -vET, -e = -vE, -t = -vT.
  const opts: Options = {
    number: Boolean(flags.n),
    numberNonblank: Boolean(flags.b),
    squeeze: Boolean(flags.s),
    showEnds: Boolean(flags.E) || Boolean(flags.A) || Boolean(flags.e),
    showTabs: Boolean(flags.T) || Boolean(flags.A) || Boolean(flags.t),
    showNonprint: Boolean(flags.v) || Boolean(flags.A) || Boolean(flags.e) || Boolean(flags.t),
  };
  const formatting = opts.number || opts.numberNonblank || opts.squeeze || opts.showEnds || opts.showTabs || opts.showNonprint;

  const sources = positionals.length > 0 ? positionals : ['-'];
  let exitCode = 0;
  let stdinAborted = false;
  const state = { lineNo: 1, blanks: 0 };

  try {
    for (const src of sources) {
      if (src === '-') {
        if (!formatting) {
          // Raw byte passthrough — stream so a downstream break cancels early.
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
        // Formatting flags: buffer stdin to apply line semantics.
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
        await writeBytes(out, formatBytes(combined, opts, state));
        continue;
      }

      if (!formatting) {
        try {
          if (await streamFile(io, src, out)) { stdinAborted = true; break; }
        } catch (e) {
          await writeLine(err, `${name}: ${src}: ${errnoText(e)}`);
          exitCode = 1;
        }
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(io, src);
      } catch (e) {
        await writeLine(err, `${name}: ${src}: ${errnoText(e)}`);
        exitCode = 1;
        continue;
      }
      await writeBytes(out, formatBytes(bytes, opts, state));
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
