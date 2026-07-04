/**
 * `awk` — pattern-directed scanning and processing language (POSIX).
 *
 * A pure-TypeScript awk: this entry wires the kernel-facing {@link CommandIO}
 * (argv, stdin, fs syscalls) to the standalone interpreter under `./awk/`
 * (lexer → parser → tree-walking {@link Interpreter}). The interpreter never
 * touches the harness; this file is the only kernel-aware part.
 *
 * CLI (POSIX):
 *   awk [-F fs] [-v var=val]... 'program' [file...]
 *   awk [-F fs] [-v var=val]... -f progfile [-f progfile]... [file...]
 *
 * Input: each operand file is read via `fs/*` syscalls; with no files (or `-`)
 * awk reads stdin. Output redirection (`print > file`, `>>`, `getline < file`)
 * is backed by buffered `fs/*` reads/writes. The `print | cmd` and
 * `cmd | getline` command forms are NOT supported in the sandbox (no external
 * processes); they report an error / return -1 rather than spawning anything.
 *
 * Built via the repo's preserveModules vite config to `dist/commands/awk.js`
 * alongside `dist/commands/awk/*.js`; the relative `./awk/*.ts` imports resolve
 * in dist as `./awk/*.js`.
 */
import { defineCommand, readAllText, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { parseProgram, AwkFatalError } from './awk/parser.ts';
import { Interpreter } from './awk/interp.ts';
import type { AwkIO, InputSource } from './awk/interp.ts';

interface AwkCli {
  fs?: string;
  assigns: Record<string, string>;
  progFiles: string[];
  programText?: string;
  files: string[];
}

/**
 * Parse awk's idiosyncratic CLI by hand: `-F`/`-v`/`-f` take values (attached or
 * separate), the first non-option operand is the program text UNLESS `-f` was
 * given, and everything after is a file operand. `--` ends options; `-` is a
 * file operand (stdin).
 */
function parseAwkArgs(argv: string[]): AwkCli {
  const cli: AwkCli = { assigns: {}, progFiles: [], files: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-' || !a.startsWith('-')) break;
    if (a === '--') { i++; break; }
    const flag = a[1];
    const attached = a.slice(2);
    if (flag === 'F') { cli.fs = attached !== '' ? attached : argv[++i] ?? ''; continue; }
    if (flag === 'v') {
      const kv = attached !== '' ? attached : argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq >= 0) cli.assigns[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    if (flag === 'f') { cli.progFiles.push(attached !== '' ? attached : argv[++i] ?? ''); continue; }
    // Unknown option: stop option parsing (treat as program/file).
    break;
  }
  // Program text: required only if no -f program files were given.
  if (cli.progFiles.length === 0) {
    cli.programText = argv[i++];
  }
  for (; i < argv.length; i++) cli.files.push(argv[i]);
  return cli;
}

/** Translate a `-F` value the way awk does: `-F'\t'` means a tab. A `-Ft` with a
 * single `t` is literal; only escapes are decoded. */
function decodeFs(fs: string): string {
  if (fs === '\\t') return '\t';
  if (!fs.includes('\\')) return fs;
  return fs
    .replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

// ── fs syscall helpers (kernel-backed file I/O) ────────────────────────────────

async function readFileText(io: CommandIO, path: string): Promise<string> {
  const { fd } = (await io.syscall('fs/open', { dirfd: -100, path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

async function writeFileText(io: CommandIO, path: string, content: string, append: boolean): Promise<void> {
  const oflags = append
    ? { write: true, create: true, append: true }
    : { write: true, create: true, truncate: true };
  const { fd } = (await io.syscall('fs/open', { dirfd: -100, path, oflags })) as { fd: number };
  try {
    const bytes = new TextEncoder().encode(content);
    let written = 0;
    while (written < bytes.byteLength) {
      const r = (await io.syscall('fs/write', { fd, data: bytes.subarray(written) })) as { written: number };
      if (!r || r.written <= 0) break;
      written += r.written;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/** Strip a redundant leading `<name>:` from an interpreter/parser message so we
 * don't emit a doubled prefix like `awk: awk: ...`. */
function errText(name: string, e: unknown): string {
  let msg = (e as Error).message ?? String(e);
  const prefix = name + ':';
  if (msg.startsWith(prefix)) msg = msg.slice(prefix.length).replace(/^\s+/, '');
  return `${name}: ${msg}`;
}

const awkCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'awk';
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  // Buffer stdout/stderr so the synchronous interpreter can `write()` freely;
  // flush once at the end. Output redirect goes to a cache of pending file
  // writes, flushed after the run (so `>` truncates once, `>>`/repeat appends).
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const fileWrites = new Map<string, { text: string; append: boolean }>();
  // Cache of files read by `getline < file`, fetched eagerly before the run.
  const fileCache = new Map<string, string | undefined>();

  try {
    const cli = parseAwkArgs(io.args.slice(1));

    // Assemble the program text from -f files or the inline program operand.
    let programText: string;
    if (cli.progFiles.length > 0) {
      const parts: string[] = [];
      for (const pf of cli.progFiles) {
        try { parts.push(await readFileText(io, pf)); }
        catch { await writeLine(err, `${name}: can't open file ${pf}`); return 2; }
      }
      programText = parts.join('\n');
    } else if (cli.programText !== undefined) {
      programText = cli.programText;
    } else {
      await writeLine(err, `usage: ${name} [-F fs][-v var=val][-f progfile | 'prog'] [file ...]`);
      return 2;
    }

    let program;
    try {
      program = parseProgram(programText);
    } catch (e) {
      await writeLine(err, errText(name, e));
      // A wrong-builtin-arity diagnostic exits 1 in gawk; a plain syntax error exits 2.
      return e instanceof AwkFatalError ? e.exitCode : 2;
    }

    // Read all input sources up front (the interpreter is synchronous). With no
    // file operands (or a `-`), read stdin once. But a program with only BEGIN
    // rule(s) reads NOTHING — gawk does not read stdin nor open file operands —
    // so gate every input read on whether the parsed program needs input; else a
    // BEGIN-only program would block forever on an unclosed fd 0.
    const inputs: InputSource[] = [];
    const fileArgs = cli.files;
    if (Interpreter.programNeedsInput(program)) {
      if (fileArgs.length === 0) {
        inputs.push({ name: '', text: await readAllText(io.stdin) });
      } else {
        for (const f of fileArgs) {
          if (f === '-') { inputs.push({ name: '', text: await readAllText(io.stdin) }); continue; }
          try { inputs.push({ name: f, text: await readFileText(io, f) }); }
          catch {
            await writeLine(err, `${name}: can't open file ${f}`);
            // POSIX awk: a missing file is a fatal-ish error; continue but mark.
            inputs.push({ name: f, text: '' });
          }
        }
      }
    }

    // Pre-scan the program text for `getline < "literal"` files so we can read
    // them synchronously during the run. Dynamic getline-file names are read on
    // demand only if already cached; otherwise they error (return -1).
    for (const m of programText.matchAll(/getline[^<]*<\s*"((?:\\.|[^"\\])*)"/g)) {
      const path = m[1].replace(/\\"/g, '"');
      if (!fileCache.has(path)) {
        try { fileCache.set(path, await readFileText(io, path)); }
        catch { fileCache.set(path, undefined); }
      }
    }

    const awkIo: AwkIO = {
      write: (t) => { outBuf.push(t); },
      writeErr: (t) => { errBuf.push(t); },
      writeFile: (path, text, append) => {
        const prev = fileWrites.get(path);
        if (prev && (append || prev.append)) fileWrites.set(path, { text: prev.text + text, append: prev.append });
        else fileWrites.set(path, { text, append });
      },
      readFile: (path) => fileCache.get(path),
      // Command pipes are unavailable in the sandbox.
    };

    const interp = new Interpreter(program, awkIo, {
      fs: cli.fs !== undefined ? decodeFs(cli.fs) : undefined,
      assigns: cli.assigns,
      argv: fileArgs,
    });

    let code: number;
    try {
      code = interp.run(inputs);
    } catch (e) {
      await writeLine(err, errText(name, e));
      return 2;
    }

    // Flush buffered stdout and any redirected file writes.
    if (outBuf.length > 0) await out.write(new TextEncoder().encode(outBuf.join('')));
    for (const e of errBuf) await err.write(new TextEncoder().encode(e));
    for (const [path, w] of fileWrites) {
      try { await writeFileText(io, path, w.text, w.append); }
      catch (e) { await writeLine(err, `${name}: can't write ${path}: ${(e as Error).message}`); }
    }
    return code;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(awkCommand);

// Exported for direct unit testing without a kernel.
export { awkCommand };
