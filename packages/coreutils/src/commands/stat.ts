/**
 * `stat` — display file status.
 *   -c / --format FMT : output FMT, expanding %-directives (a trailing newline
 *                       is added after each operand)
 *   --printf FMT      : like -c but no added newline and backslash escapes in
 *                       FMT are interpreted
 *   -L / --dereference: follow symlinks (stat the target)
 *   -t / --terse      : terse one-line output (16 space-separated fields)
 *
 * Supported format directives (GNU subset):
 *   %n name   %N quoted name   %s size   %f raw mode (hex)   %a access (octal)
 *   %A access rights (`-rw-r--r--`)   %F file type (human)   %h hard link count
 *   %b blocks (512B units)   %B block size for %b (512)   %o optimal IO block size
 *   %i inode   %d device (dec)   %D device (hex)   %t major (hex)   %T minor (hex)
 *   %u uid   %g gid   %U owner name   %G group name
 *   %X atime (epoch s)   %Y mtime (epoch s)   %Z ctime (epoch s)   %W btime (epoch s)
 *   %% literal percent
 *
 * SANDBOX DIVERGENCE (documented): the VFS carries no ownership, inode, device,
 * or block-allocation model. So `%U`/`%G` are static "root" placeholders, `%u`/
 * `%g`/`%i`/`%d`/`%D`/`%t`/`%T` are synthetic/zero, and `%b`/`%o` use fixed
 * assumptions (`ceil(size/512)`, 4096). These CANNOT byte-match GNU on a real
 * filesystem; only the mode-derived directives (`%a`/`%A`/`%f`/`%F`/`%s`/`%h`)
 * and the constant `%B` match. The default and `-t` outputs are GNU-shaped for
 * field-splitting parsers, not byte-exact.
 */
import { defineCommand, parseArgs, writeString, writeLine, exitWith, fsErrorText, optionError } from '../harness.ts';
import { stat, normalize } from '../fs.ts';
import type { StatResult, FileType } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * Canonical POSIX errno text for an `fs/*` failure. Over the real kernel the
 * error carries a POSIX errno `code` (e.g. `ENOENT`) with a provider-specific
 * message that repeats the path; {@link fsErrorText} only maps the lowercase VFS
 * codes, so translate the errno first (and fall back for the in-memory unit-test
 * path). Using `.message` directly is the "operand doubled" bug.
 */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'No such file or directory', EACCES: 'Permission denied', EEXIST: 'File exists',
  ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EXDEV: 'Invalid cross-device link',
  ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', ENOSPC: 'No space left on device',
  EIO: 'Input/output error',
};
function errnoText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  return (code && ERRNO_TEXT[code]) ?? fsErrorText(err);
}

const TYPE_NAMES: Record<FileType, string> = {
  'file': 'regular file',
  'directory': 'directory',
  'symlink': 'symbolic link',
  'block-device': 'block special file',
  'character-device': 'character special file',
  'fifo': 'fifo',
  'socket': 'socket',
  'unknown': 'unknown',
};

// POSIX high bits of the raw mode by file type (st_mode format bits), so `%f`
// mirrors GNU's `81a4` (S_IFREG | 0644) etc.
const TYPE_BITS: Record<FileType, number> = {
  'file': 0o100000, 'directory': 0o040000, 'symlink': 0o120000,
  'block-device': 0o060000, 'character-device': 0o020000, 'fifo': 0o010000,
  'socket': 0o140000, 'unknown': 0,
};

const TYPE_CHAR: Record<FileType, string> = {
  'file': '-', 'directory': 'd', 'symlink': 'l', 'block-device': 'b',
  'character-device': 'c', 'fifo': 'p', 'socket': 's', 'unknown': '?',
};

const epochSeconds = (t: string | number | Date): number => Math.floor(new Date(t).getTime() / 1000);

/** rwx triad for a 3-bit permission group. */
const triad = (bits: number): string =>
  (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');

/** Format a mode + type into `-rw-r--r--`. */
function permString(type: FileType, mode: number): string {
  return TYPE_CHAR[type] + triad((mode >> 6) & 7) + triad((mode >> 3) & 7) + triad(mode & 7);
}

/** The raw st_mode: type format bits OR the permission bits. */
const rawMode = (st: StatResult): number => TYPE_BITS[st.type] | (st.mode & 0o7777);

/** A stable synthetic inode (the VFS carries none) — never byte-matches GNU. */
function synthInode(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 90000000 + 10000000;
}

/** Expand one `%X` directive against a stat result. */
function expand(spec: string, name: string, st: StatResult): string {
  switch (spec) {
    case 'n': return name;
    case 'N': return `'${name}'`;
    case 's': return String(st.size);
    case 'f': return rawMode(st).toString(16);
    case 'a': return (st.mode & 0o7777).toString(8);
    case 'A': return permString(st.type, st.mode);
    case 'F': return TYPE_NAMES[st.type] ?? 'unknown';
    case 'h': return String(st.linkCount);
    case 'b': return String(Math.ceil(st.size / 512)); // 512B blocks (best effort)
    case 'B': return '512';                             // block size for %b
    case 'o': return '4096';                            // optimal IO block size
    case 'i': return String(synthInode(name));          // synthetic inode
    case 'd': return '0';                               // device (dec) — none in VFS
    case 'D': return '0';                               // device (hex) — none in VFS
    case 't': return '0';                               // major device (hex)
    case 'T': return '0';                               // minor device (hex)
    case 'u': return '0';                               // uid — no ownership model
    case 'g': return '0';                               // gid — no ownership model
    case 'U': return 'root';                            // owner name placeholder
    case 'G': return 'root';                            // group name placeholder
    case 'X': return String(epochSeconds(st.atime));
    case 'Y': return String(epochSeconds(st.mtime));
    case 'Z': return String(epochSeconds(st.ctime));
    case 'W': return String(epochSeconds(st.ctime));    // birth time (no btime → ctime)
    case '%': return '%';
    default: return '?';                                // GNU prints `?` for an unknown directive
  }
}

/**
 * Apply a GNU-style format string, expanding %-directives. When `escapes` is
 * true (`--printf`) backslash escapes (`\n`, `\t`, …) are interpreted; `-c`
 * passes the format through literally except for `\n`/`\t` (GNU -c does not
 * process escapes, but the historical mithic behavior — and the tests — treat
 * `\n`/`\t` as escapes for -c too; the caller controls this via `escapes`).
 */
function applyFormat(fmt: string, name: string, st: StatResult, escapes: boolean): string {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '%' && i + 1 < fmt.length) { out += expand(fmt[++i], name, st); }
    else if (escapes && c === '\\' && i + 1 < fmt.length) {
      const n = fmt[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '\\' ? '\\' : n;
    } else { out += c; }
  }
  return out;
}

/** Default (no -c) multi-line summary — GNU-shaped (see the SANDBOX DIVERGENCE note). */
function defaultFormat(name: string, st: StatResult): string {
  const perms = (st.mode & 0o7777).toString(8).padStart(4, '0');
  const blocks = Math.ceil(st.size / 512);
  const iso = (t: string | number | Date): string => new Date(t).toISOString().replace('T', ' ').replace('Z', ' +0000');
  return (
    `  File: ${name}\n` +
    `  Size: ${st.size}\t\tBlocks: ${blocks}          IO Block: 4096   ${TYPE_NAMES[st.type] ?? 'unknown'}\n` +
    `Device: 0,0\tInode: ${synthInode(name)}   Links: ${st.linkCount}\n` +
    `Access: (${perms}/${permString(st.type, st.mode)})  Uid: (    0/    root)   Gid: (    0/    root)\n` +
    `Access: ${iso(st.atime)}\n` +
    `Modify: ${iso(st.mtime)}\n` +
    `Change: ${iso(st.ctime)}\n` +
    ` Birth: ${iso(st.ctime)}`
  );
}

/** Terse (`-t`) one-line output: 16 space-separated fields, GNU field order. */
function terseFormat(name: string, st: StatResult): string {
  return applyFormat('%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o', name, st, false);
}

const statCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'stat';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['L', 't', 'f'],
    string: ['c', 'printf'],
    alias: { format: 'c', dereference: 'L', terse: 't', 'file-system': 'f' },
    unknown: 'error',
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;
  const follow = Boolean(parsed.flags.L);

  try {
    if (parsed.unknown.length) {
      return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    }
    const { positionals, flags } = parsed;
    if (positionals.length === 0) {
      // GNU appends the Try-help line to the missing-operand diagnostic.
      return await exitWith(err, 1, `${name}: missing operand\nTry '${name} --help' for more information.`);
    }
    // `--printf` interprets escapes and adds no trailing newline; `-c`/--format
    // adds a newline per operand.
    const printfFmt = typeof flags.printf === 'string' ? flags.printf : undefined;
    const formatFmt = typeof flags.c === 'string' ? flags.c : undefined;

    for (const file of positionals) {
      let st: StatResult;
      try {
        st = await stat(io, normalize(file), follow);
      } catch (e) {
        // Use the errno-derived text (NOT e.message, which leaks the path a
        // second time on memory/opfs providers → the "operand doubled" bug).
        await writeLine(err, `${name}: cannot stat '${file}': ${errnoText(e)}`);
        code = 1;
        continue;
      }
      if (printfFmt !== undefined) {
        await writeString(out, applyFormat(printfFmt, file, st, true));
      } else if (formatFmt !== undefined) {
        await writeLine(out, applyFormat(formatFmt, file, st, true));
      } else if (flags.t) {
        await writeLine(out, terseFormat(file, st));
      } else {
        await writeLine(out, defaultFormat(file, st));
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(statCommand);
export { statCommand, applyFormat, permString, terseFormat };
