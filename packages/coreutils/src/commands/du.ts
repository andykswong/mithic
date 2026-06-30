/**
 * `du` — estimate file space usage.
 *
 * Forms:
 *   du [-s] [-a] [-h] [PATH...]
 *     -s   print only a grand total for each argument
 *     -a   include individual files (not just directories)
 *     -h   human-readable sizes (e.g. `3.0K`, `2.0M`)
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
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
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
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['s', 'a', 'h'],
    alias: { summarize: 's', all: 'a', 'human-readable': 'h' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const summary = Boolean(flags.s);
  const all = Boolean(flags.a);
  const humanFlag = Boolean(flags.h);
  let code = 0;

  const render = (bytes: number): string => (humanFlag ? human(bytes) : String(toBlocks(bytes)));

  // Recursively report `path`, returning its total byte size. Lines for
  // descendants are emitted before the parent line (post-order, GNU-like).
  async function report(path: string, isArg: boolean): Promise<number> {
    let st;
    try { st = await stat(io, path, false); }
    catch { await writeLine(err, `${name}: cannot access '${path}': No such file or directory`); code = 1; return 0; }

    if (st.type !== 'directory') {
      // A plain file prints when it is an explicit argument (descendant files
      // are handled by the -a branch in the directory walk below).
      if (isArg) await writeLine(out, `${render(st.size)}\t${path}`);
      return st.size;
    }

    let total = 0;
    let entries: DirEntry[];
    try { entries = await readdir(io, path); } catch { entries = []; }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of entries) {
      const child = joinPath(path, e.name);
      if (e.type === 'directory') {
        total += await report(child, false);
      } else {
        let cst;
        try { cst = await stat(io, child, false); } catch { continue; }
        total += cst.size;
        if (all && !summary) await writeLine(out, `${render(cst.size)}\t${child}`);
      }
    }
    // Print this directory's own line (unless -s and it is NOT the argument).
    if (!summary || isArg) await writeLine(out, `${render(total)}\t${path}`);
    return total;
  }

  try {
    const targets = positionals.length > 0 ? positionals : ['.'];
    for (const t of targets) await report(normalize(t), true);
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(duCommand);
export { duCommand, toBlocks, human };
