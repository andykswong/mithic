/**
 * `du` — estimate file space usage.
 *
 * Forms:
 *   du [-s] [-a] [-h] [-b] [-c] [-0] [--max-depth=N | -d N] [PATH...]
 *     -s              print only a grand total for each argument
 *     -a              include individual files (not just directories)
 *     -h              human-readable sizes (e.g. `3.0K`, `2.0M`)
 *     -b / --bytes    apparent byte size (exact byte sum, NOT block-rounded)
 *     -c / --total    print a grand `total` line after all arguments
 *     -0 / --null     end each output record with NUL instead of newline
 *     -d N / --max-depth=N  only print entries at most N levels below an argument
 *   PATH defaults to `.`.
 *
 * SIZE MODEL (virtual-FS divergence — documented deliberately): a directory's
 * usage is `ceil(sum-of-descendant-file-bytes / 1024)` KiB. Real GNU `du`
 * reports allocated blocks (`st_blocks`, 512-byte units, filesystem rounding),
 * which the MemoryFs/OPFS providers do not model. The byte-sum/1024-ceil model
 * is deterministic over the virtual FS and is what these tests assert against —
 * it will NOT match GNU's exact block accounting on a real filesystem.
 *
 * Because rounding is applied per entry, `-a` per-file blocks (`ceil(file/1024)`
 * each) need not sum to the parent directory's `ceil(sum/1024)` total — the
 * per-file ceilings round up independently. This non-additivity is inherent to
 * any block-rounding model (real GNU `du` shows the same with `st_blocks`); the
 * lines are NOT meant to add up arithmetically.
 *
 * Output order matches GNU's post-order walk: descendants are printed before
 * their parent, and each PATH argument's own total is printed last. Entries are
 * sorted for deterministic output.
 */
import { defineCommand, parseArgs, writeString, exitWith, optionError } from '../harness.ts';
import { stat, readdir, joinPath, normalize } from '../fs.ts';
import type { DirEntry } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** ceil(bytes / 1024) — the KiB block count under the documented model. */
const toBlocks = (bytes: number): number => Math.ceil(bytes / 1024);

/** Human-readable rendering of a byte count, GNU `du -h` style (`3.0K`). */
function human(bytes: number): string {
  const units = ['', 'K', 'M', 'G', 'T'];
  if (bytes < 1024) return String(bytes);
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + units[i];
}

const duCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'du';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['s', 'a', 'h', 'b', 'c', '0', 'S', 'k', 'L', 'x'],
    string: ['d', 'max-depth', 'block-size'],
    alias: {
      summarize: 's', all: 'a', 'human-readable': 'h', bytes: 'b', total: 'c',
      null: '0', 'max-depth': 'd',
    },
    unknown: 'error',
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  if (parsed.unknown.length) {
    const rc = await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    return rc;
  }
  const { positionals, flags } = parsed;
  const summary = Boolean(flags.s);
  const all = Boolean(flags.a);
  const humanFlag = Boolean(flags.h);
  const bytes = Boolean(flags.b);
  const grand = Boolean(flags.c);
  const sep = flags['0'] ? '\x00' : '\n';
  // `-d N` / `--max-depth=N`; `-s` is equivalent to `--max-depth=0`.
  const maxDepth = summary ? 0
    : typeof flags.d === 'string' && flags.d !== '' ? Math.max(0, Number(flags.d) | 0)
      : Infinity;
  let code = 0;

  // `-b` reports the exact apparent byte sum; otherwise 1024-byte blocks (the
  // documented ceil(bytes/1024) model — see header) or a human-readable size.
  const render = (n: number): string =>
    bytes ? String(n) : humanFlag ? human(n) : String(toBlocks(n));

  const emit = (n: number, path: string): Promise<void> =>
    writeString(out, `${render(n)}\t${path}${sep}`);

  // The `-c` grand total (block mode) is the SUM of each argument's block count,
  // not the block count of the summed bytes — GNU rounds per entry. In `-b` mode
  // the sum of exact bytes is itself exact; in human mode we sum bytes.
  let grandBlocks = 0;
  let grandBytes = 0;

  // Recursively report `path`, returning its total byte size. `depth` is the
  // level below the top argument (0 = the argument itself). A line is printed
  // only when depth <= maxDepth. Descendants print before their parent
  // (post-order, GNU-like).
  async function report(path: string, isArg: boolean, depth: number): Promise<number> {
    let st;
    try { st = await stat(io, path, false); }
    catch { await writeString(err, `${name}: cannot access '${path}': No such file or directory\n`); code = 1; return 0; }

    if (st.type !== 'directory') {
      // A plain file prints when it is an explicit argument (descendant files
      // are handled by the -a branch in the directory walk below).
      if (isArg && depth <= maxDepth) await emit(st.size, path);
      return st.size;
    }

    let total = 0;
    let entries: DirEntry[];
    try { entries = await readdir(io, path); } catch { entries = []; }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of entries) {
      const child = joinPath(path, e.name);
      if (e.type === 'directory') {
        total += await report(child, false, depth + 1);
      } else {
        let cst;
        try { cst = await stat(io, child, false); } catch { continue; }
        total += cst.size;
        if (all && depth + 1 <= maxDepth) await emit(cst.size, child);
      }
    }
    // Print this directory's own line when its depth is within max-depth.
    if (depth <= maxDepth) await emit(total, path);
    return total;
  }

  try {
    const targets = positionals.length > 0 ? positionals : ['.'];
    for (const t of targets) {
      const argBytes = await report(normalize(t), true, 0);
      grandBytes += argBytes;
      grandBlocks += toBlocks(argBytes);
    }
    if (grand) {
      const total = `${bytes ? String(grandBytes) : humanFlag ? human(grandBytes) : String(grandBlocks)}\ttotal${sep}`;
      await writeString(out, total);
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(duCommand);
export { duCommand, toBlocks, human };
