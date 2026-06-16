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
 *
 * Plain (non-`-l`, non-`-1`) output is laid out in columns to ~80 chars.
 */
import { defineCommand, parseArgs, writeLine, writeString } from '../harness.ts';
import { stat, readdir, joinPath, normalize } from '../fs.ts';
import type { StatResult, FileType, DirEntry } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

interface Row { name: string; type: FileType; st?: StatResult; }

/** Resolved ls option flags. */
interface LsOptions {
  long: boolean; all: boolean; almost: boolean; one: boolean; recurse: boolean;
  dirSelf: boolean; timeSort: boolean; reverse: boolean; sizeSort: boolean; human: boolean;
}

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

const ls: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['l', 'a', 'A', '1', 'R', 'd', 't', 'r', 'S', 'h'],
    alias: { all: 'a', almost: 'A', reverse: 'r', recursive: 'R', human: 'h' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;

  const opt: LsOptions = {
    long: Boolean(flags.l), all: Boolean(flags.a), almost: Boolean(flags.A),
    one: Boolean(flags['1']), recurse: Boolean(flags.R), dirSelf: Boolean(flags.d),
    timeSort: Boolean(flags.t), reverse: Boolean(flags.r), sizeSort: Boolean(flags.S),
    human: Boolean(flags.h),
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
        await writeLine(err, `ls: cannot access '${t}': No such file or directory`);
        code = 1;
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
  // Resolve stats when needed for sort / long output.
  if (opt.long || opt.timeSort || opt.sizeSort) {
    for (const r of rows) {
      if (r.name === '.' || r.name === '..') continue;
      try { r.st = await stat(io, joinPath(dir, r.name), false); } catch { /* leave undefined */ }
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

  if (opt.long) {
    for (const r of sorted) {
      const st = r.st;
      const perms = st ? permString(r.type, st.mode) : permString(r.type, 0);
      const links = st ? st.linkCount : 1;
      const size = st ? (opt.human ? humanSize(st.size) : String(st.size)) : '0';
      const mtime = st ? epochToStr(st.mtime) : '';
      await writeLine(out, `${perms} ${String(links).padStart(2)} ${size.padStart(8)} ${mtime} ${r.name}`);
    }
    return;
  }
  if (opt.one) {
    for (const r of sorted) await writeLine(out, r.name);
    return;
  }
  // Column layout for plain output (width ~80).
  await writeString(out, columns(sorted.map(r => r.name)));
}

const mtimeOf = (r: Row): number => (r.st ? new Date(r.st.mtime).getTime() : 0);

/** A compact, deterministic mtime rendering (epoch seconds) for -l. */
function epochToStr(t: string | number | Date): string {
  return String(Math.floor(new Date(t).getTime() / 1000)).padStart(11);
}

/** Lay names out in space-padded columns wrapping at 80 chars. */
function columns(names: string[]): string {
  if (names.length === 0) return '';
  const width = Math.max(...names.map(n => n.length)) + 2;
  const perLine = Math.max(1, Math.floor(80 / width));
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const last = i === names.length - 1 || (i + 1) % perLine === 0;
    out += last ? names[i] + '\n' : names[i].padEnd(width);
  }
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

export default defineCommand(ls);
export { ls as lsCommand, columns, permString, humanSize };
