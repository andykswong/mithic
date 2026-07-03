/**
 * `ls` — list directory contents.
 *   -l : long format (mode, links, size, mtime, name)
 *   -a : include entries starting with `.` (and synthesize `.`/`..` in -a)
 *   -A : like -a but without `.`/`..`
 *   -1 : one entry per line
 *   -R : recurse into subdirectories
 *   -d : list directories themselves, not their contents
 *   -t : sort by mtime (newest first)
 *   -S : sort by size (largest first)
 *   -r : reverse the sort order
 *   -h : human-readable sizes (with -l)
 *   -F : append a classify indicator to each name — `/` dir, `*` executable
 *        (mode & 0o111), `@` symlink, nothing for a regular file
 *   -i : print each entry's inode number
 *   -m : fill width with a comma+space separated list
 *   -x : multi-column, entries listed across (rows first)
 *   -C : multi-column, entries listed down (columns first)
 *
 * Output layout follows GNU: to a TTY the default is multi-column (down);
 * to a pipe/redirect the default is one entry per line. `-C`/`-x`/`-m` force a
 * column layout regardless of destination.
 */
import { defineCommand, parseArgs, writeLine, writeString, exitWith, optionError } from '../harness.ts';
import { stat, readdir, joinPath, normalize } from '../fs.ts';
import type { StatResult, FileType, DirEntry } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

interface Row { name: string; type: FileType; st?: StatResult; }

/** How multi-column output is laid out. */
type ColumnMode = 'vertical' | 'horizontal' | 'commas' | 'one';

/** Resolved ls option flags. */
interface LsOptions {
  long: boolean; all: boolean; almost: boolean; one: boolean; recurse: boolean;
  dirSelf: boolean; timeSort: boolean; reverse: boolean; sizeSort: boolean; human: boolean;
  classify: boolean; inode: boolean;
  /** Layout for non-`-l` output when more than one entry is shown. */
  columnMode: ColumnMode;
}

// The VFS has no ownership model; ls -l prints static placeholders so the
// owner/group columns exist and field-splitting parsers see the 7-field layout.
const OWNER = 'root';
const GROUP = 'root';

const TYPE_CHAR: Record<FileType, string> = {
  'file': '-', 'directory': 'd', 'symlink': 'l', 'block-device': 'b',
  'character-device': 'c', 'fifo': 'p', 'socket': 's', 'unknown': '?',
};

/** rwx triad string for a 3-bit permission group. */
function triad(bits: number): string {
  return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
}

/** Format a mode into `drwxr-xr-x`. */
function permString(type: FileType, mode: number): string {
  return TYPE_CHAR[type] + triad((mode >> 6) & 7) + triad((mode >> 3) & 7) + triad(mode & 7);
}

/** Human-readable size like `1.5K`, `2.0M`. */
function humanSize(n: number): string {
  const units = ['', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  if (i === 0) return String(n);
  return (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + units[i];
}

/**
 * The `-F` classify indicator for a row: `/` directory, `@` symlink,
 * `*` executable regular file (mode & 0o111), else nothing.
 */
function classifySuffix(r: Row): string {
  if (r.type === 'directory') return '/';
  if (r.type === 'symlink') return '@';
  if (r.type === 'file' && r.st && (r.st.mode & 0o111) !== 0) return '*';
  return '';
}

const ls: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    // Every GNU ls single-letter option is declared so an *undeclared* flag is
    // the only thing that triggers the `unknown` path (exit 2). Options we do
    // not implement are still accepted (as no-ops), matching GNU's acceptance.
    boolean: [
      'l', 'a', 'A', '1', 'R', 'd', 't', 'r', 'S', 'h', 'F', 'i', 'm', 'x', 'C',
      'B', 'D', 'G', 'H', 'L', 'N', 'Q', 'U', 'X', 'Z', 'b', 'c', 'f', 'g', 'k',
      'n', 'o', 'p', 'q', 's', 'u', 'v',
    ],
    string: ['w', 'I', 'T', 'block-size', 'format', 'color', 'sort', 'time',
      'time-style', 'quoting-style', 'indicator-style', 'hide', 'width', 'tabsize'],
    alias: {
      all: 'a', 'almost-all': 'A', reverse: 'r', recursive: 'R', human: 'h',
      'human-readable': 'h', classify: 'F', directory: 'd', inode: 'i', size: 's',
      dereference: 'L', escape: 'b',
    },
    unknown: 'error',
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const name = io.args[0] ?? 'ls';
  if (parsed.unknown.length) {
    // GNU ls uses exit 2 for a usage/option error.
    const rc = await exitWith(err, 2, optionError(name, parsed.unknown[0]));
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    return rc;
  }
  const { positionals, flags } = parsed;
  let code = 0;

  // Layout selection. `-C`/`-x`/`-m` force a column layout; `-1` (and `-l`,
  // handled separately) force one-per-line. Otherwise the default depends on
  // the destination: multi-column (down) to a TTY, one-per-line to a pipe.
  const toTty = io.isatty?.(1) ?? false;
  let columnMode: ColumnMode;
  if (flags.m) columnMode = 'commas';
  else if (flags.x) columnMode = 'horizontal';
  else if (flags.C) columnMode = 'vertical';
  else if (flags['1']) columnMode = 'one';
  else columnMode = toTty ? 'vertical' : 'one';

  const opt: LsOptions = {
    long: Boolean(flags.l || flags.g || flags.o || flags.n), all: Boolean(flags.a), almost: Boolean(flags.A),
    one: Boolean(flags['1']), recurse: Boolean(flags.R), dirSelf: Boolean(flags.d),
    timeSort: Boolean(flags.t), reverse: Boolean(flags.r), sizeSort: Boolean(flags.S),
    human: Boolean(flags.h), classify: Boolean(flags.F || flags.p), inode: Boolean(flags.i),
    columnMode,
  };

  try {
    const targets = positionals.length > 0 ? positionals : ['.'];
    const multi = targets.length > 1;

    // Separate file vs directory operands; files print first (GNU groups them).
    const dirs: string[] = [];
    const files: Row[] = [];
    for (const t of targets) {
      try {
        const st = await stat(io, normalize(t), false);
        if (st.type === 'directory' && !opt.dirSelf) dirs.push(t);
        else files.push({ name: t, type: st.type, st });
      } catch {
        // GNU ls uses exit 2 for a serious error (cannot access an operand).
        await writeLine(err, `${name}: cannot access '${t}': No such file or directory`);
        code = 2;
      }
    }

    if (files.length > 0) {
      await emitRows(files, opt, out);
    }

    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      if (multi || opt.recurse || files.length > 0) {
        if (i > 0 || files.length > 0) await writeString(out, '\n');
        await writeLine(out, `${dir}:`);
      }
      await listDir(io, normalize(dir), opt, out, err);
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

async function listDir(
  io: CommandIO, dir: string, opt: LsOptions,
  out: WritableStreamDefaultWriter<Uint8Array>, err: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await readdir(io, dir);
  } catch (e) {
    await writeLine(err, `ls: cannot open directory '${dir}': ${(e as Error).message}`);
    return;
  }
  const rows: Row[] = [];
  if (opt.all) {
    rows.push({ name: '.', type: 'directory' }, { name: '..', type: 'directory' });
  }
  for (const e of entries) {
    if (!opt.all && !opt.almost && e.name.startsWith('.')) continue;
    rows.push({ name: e.name, type: e.type });
  }
  // Resolve stats when needed for sort / long output / -F executable detection / -i.
  // `.`/`..` are stat'd too (GNU shows real dir perms, not `d---------`).
  if (opt.long || opt.timeSort || opt.sizeSort || opt.classify || opt.inode) {
    for (const r of rows) {
      const target = r.name === '.' ? dir : r.name === '..' ? joinPath(dir, '..') : joinPath(dir, r.name);
      try { r.st = await stat(io, target, false); } catch { /* leave undefined */ }
    }
  }

  await emitRows(rows, opt, out);

  if (opt.recurse) {
    for (const r of rows) {
      if (r.type === 'directory' && r.name !== '.' && r.name !== '..') {
        await writeString(out, '\n');
        const sub = joinPath(dir, r.name);
        await writeLine(out, `${sub}:`);
        await listDir(io, sub, opt, out, err);
      }
    }
  }
}

/** Sort + render a set of rows according to the active flags. */
async function emitRows(
  rows: Row[], opt: LsOptions, out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const sorted = [...rows];
  if (opt.timeSort) {
    sorted.sort((a, b) => mtimeOf(b) - mtimeOf(a));
  } else if (opt.sizeSort) {
    sorted.sort((a, b) => (b.st?.size ?? 0) - (a.st?.size ?? 0));
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (opt.reverse) sorted.reverse();

  // The inode number (`-i`) is a synthetic, deterministic value: the VFS carries
  // no real inode, so this can never byte-match GNU on a real FS. It exists so the
  // `-i` column layout is present and field-splitting parsers see it.
  const inodeOf = (r: Row): string => String(synthInode(r.name));
  const display = (r: Row): string =>
    (opt.inode ? inodeOf(r) + ' ' : '') + r.name + (opt.classify ? classifySuffix(r) : '');

  if (opt.long) {
    // Long format: `total N` header then one row per entry:
    //   mode links owner group size mtime name
    // The VFS carries no ownership (owner/group are static "root" placeholders)
    // and MemoryFs mtimes are not the real-FS mtimes GNU reports, so the date and
    // total block count cannot byte-match GNU — the layout/fields are GNU-shaped.
    const totalBlocks = sorted.reduce((s, r) => s + (r.st ? Math.ceil(r.st.size / 1024) * 2 : 0), 0);
    await writeLine(out, `total ${totalBlocks}`);
    const linkW = Math.max(1, ...sorted.map((r) => String(r.st ? r.st.linkCount : 1).length));
    const sizeW = Math.max(1, ...sorted.map((r) => {
      const st = r.st;
      return (st ? (opt.human ? humanSize(st.size) : String(st.size)) : '0').length;
    }));
    for (const r of sorted) {
      const st = r.st;
      const perms = st ? permString(r.type, st.mode) : permString(r.type, 0);
      const links = String(st ? st.linkCount : 1).padStart(linkW);
      const size = (st ? (opt.human ? humanSize(st.size) : String(st.size)) : '0').padStart(sizeW);
      const mtime = st ? mtimeToDate(st.mtime) : mtimeToDate(0);
      const inode = opt.inode ? inodeOf(r) + ' ' : '';
      await writeLine(
        out,
        `${inode}${perms} ${links} ${OWNER} ${GROUP} ${size} ${mtime} ${r.name + (opt.classify ? classifySuffix(r) : '')}`,
      );
    }
    return;
  }
  const names = sorted.map(display);
  if (opt.columnMode === 'one') {
    for (const n of names) await writeLine(out, n);
    return;
  }
  if (opt.columnMode === 'commas') {
    await writeString(out, commaList(names));
    return;
  }
  await writeString(out, columns(names, opt.columnMode === 'horizontal'));
}

const mtimeOf = (r: Row): number => (r.st ? new Date(r.st.mtime).getTime() : 0);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * GNU `ls -l` date rendering: `Mon DD HH:MM` for recent files. Uses UTC so it is
 * deterministic across hosts. This will not byte-match GNU (which renders the
 * real-FS mtime in the local zone) — see the -l comment in emitRows.
 */
function mtimeToDate(t: string | number | Date): string {
  const d = new Date(t);
  const mon = MONTHS[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${hh}:${mm}`;
}

/** A stable synthetic inode from a name (no real inode exists in the VFS). */
function synthInode(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 90000000 + 10000000;
}

const LINE_WIDTH = 80;
const TAB = 8;

/**
 * `indent(from, to)`: the padding GNU emits between the end of a name (`from`)
 * and the start of the next column (`to`) — tabs advancing to each tab stop,
 * then spaces for the remainder. Mirrors GNU coreutils `ls.c` `indent()`.
 */
function indent(from: number, to: number): string {
  let out = '';
  let pos = from;
  while (pos < to) {
    // A tab is worthwhile only when it lands strictly past `pos` on the way to a
    // tab stop that is still ≤ `to`. GNU's exact test: to/T > (pos+1)/T.
    if (Math.floor(to / TAB) > Math.floor((pos + 1) / TAB)) {
      out += '\t';
      pos += TAB - (pos % TAB);
    } else {
      out += ' ';
      pos++;
    }
  }
  return out;
}

/**
 * Multi-column layout matching GNU `ls`: `across=false` fills columns top-down
 * (`-C` / TTY default), `across=true` fills rows left-to-right (`-x`). Column
 * widths are computed per-column (GNU chooses the most columns that fit
 * {@link LINE_WIDTH}); padding uses {@link indent} (tabs to tab stops + spaces).
 */
function columns(names: string[], across: boolean): string {
  const n = names.length;
  if (n === 0) return '';
  const lens = names.map((s) => s.length);
  const maxCols = Math.max(1, Math.min(n, Math.floor(LINE_WIDTH / 3) || 1));

  // Find the greatest column count whose per-column widths fit LINE_WIDTH.
  let cols = 1;
  let colWidths: number[] = [Math.max(...lens)];
  for (let c = maxCols; c >= 1; c--) {
    const rows = Math.ceil(n / c);
    const widths = new Array<number>(c).fill(0);
    for (let i = 0; i < n; i++) {
      const col = across ? i % c : Math.floor(i / rows);
      const w = lens[i] + 2; // 2-space inter-column gap
      if (w > widths[col]) widths[col] = w;
    }
    let line = 0;
    for (const w of widths) line += w;
    line -= 2; // last column has no trailing gap
    if (line <= LINE_WIDTH || c === 1) { cols = c; colWidths = widths; break; }
  }

  const rows = Math.ceil(n / cols);
  let out = '';
  if (across) {
    for (let r = 0; r < rows; r++) {
      let pos = 0;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= n) break;
        out += names[i];
        pos += lens[i];
        const last = c === cols - 1 || i === n - 1;
        if (!last) { const to = pos + (colWidths[c] - lens[i]); out += indent(pos, to); pos = to; }
      }
      out += '\n';
    }
  } else {
    for (let r = 0; r < rows; r++) {
      let pos = 0;
      for (let c = 0; c < cols; c++) {
        const i = c * rows + r;
        if (i >= n) break;
        out += names[i];
        pos += lens[i];
        const isLastInRow = (c + 1) * rows + r >= n || c === cols - 1;
        if (!isLastInRow) { const to = pos + (colWidths[c] - lens[i]); out += indent(pos, to); pos = to; }
      }
      out += '\n';
    }
  }
  return out;
}

/**
 * GNU `ls -m`: names joined by `, `, wrapped so no line exceeds {@link LINE_WIDTH}.
 * The comma stays on the current line; the next name starts the next line with no
 * leading space.
 */
function commaList(names: string[]): string {
  let out = '';
  let col = 0;
  for (let i = 0; i < names.length; i++) {
    const piece = names[i];
    if (i === 0) { out += piece; col = piece.length; continue; }
    // Would `, piece` overflow the line? (2 = ", "); the comma stays on the
    // current line and the name wraps.
    if (col + 2 + piece.length > LINE_WIDTH) {
      out += ',\n' + piece;
      col = piece.length;
    } else {
      out += ', ' + piece;
      col += 2 + piece.length;
    }
  }
  return out + '\n';
}

export default defineCommand(ls);
export { ls as lsCommand, columns, commaList, indent, permString, humanSize };
