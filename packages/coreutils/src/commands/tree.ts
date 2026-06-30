/**
 * `tree` — list the contents of directories in a tree-like format.
 *
 * Forms:
 *   tree [-a] [-d] [-L N] [PATH]
 *     -a     include entries whose name starts with `.`
 *     -d     list directories only
 *     -L N   descend at most N levels below PATH
 *   PATH defaults to `.`.
 *
 * Uses the conventional `├── ` / `└── ` branch connectors and `│   ` / `    `
 * indentation. Ends with a blank line then a summary `N directories, M files`
 * (singular `directory`/`file` for counts of 1). Matching real `tree`, the
 * starting PATH itself is NOT included in the directory count.
 */
import { defineCommand, parseArgs, writeLine, exitWith } from '../harness.ts';
import { stat, readdir, joinPath } from '../fs.ts';
import type { DirEntry } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

interface TreeOpts { all: boolean; dirsOnly: boolean; maxDepth: number; }

interface Counts { dirs: number; files: number; }

const treeCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'tree';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['a', 'd'],
    string: ['L'],
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    const root = positionals[0] ?? '.';
    let maxDepth = Infinity;
    if (flags.L !== undefined) {
      const n = Number(flags.L);
      if (!Number.isInteger(n) || n < 1) return await exitWith(err, 1, `${name}: Invalid level, must be greater than 0.`);
      maxDepth = n;
    }
    const opts: TreeOpts = { all: Boolean(flags.a), dirsOnly: Boolean(flags.d), maxDepth };

    let rootStat;
    try { rootStat = await stat(io, root, false); }
    catch { return await exitWith(err, 1, `${name}: ${root}  [error opening dir]`); }

    await writeLine(out, root);
    const counts: Counts = { dirs: 0, files: 0 };
    if (rootStat.type === 'directory') {
      await walk(io, root, '', 1, opts, out, counts);
    }

    await writeLine(out, '');
    const dirPart = `${counts.dirs} ${counts.dirs === 1 ? 'directory' : 'directories'}`;
    if (opts.dirsOnly) {
      await writeLine(out, dirPart);
    } else {
      await writeLine(out, `${dirPart}, ${counts.files} ${counts.files === 1 ? 'file' : 'files'}`);
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

async function walk(
  io: CommandIO, dir: string, prefix: string, depth: number, opts: TreeOpts,
  out: WritableStreamDefaultWriter<Uint8Array>, counts: Counts,
): Promise<void> {
  if (depth > opts.maxDepth) return;
  let entries: DirEntry[];
  try { entries = await readdir(io, dir); } catch { return; }
  let visible = entries.filter((e) => opts.all || !e.name.startsWith('.'));
  if (opts.dirsOnly) visible = visible.filter((e) => e.type === 'directory');
  visible.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    const last = i === visible.length - 1;
    const branch = last ? '└── ' : '├── ';
    await writeLine(out, prefix + branch + e.name);
    if (e.type === 'directory') counts.dirs++;
    else counts.files++;
    if (e.type === 'directory') {
      const childPrefix = prefix + (last ? '    ' : '│   ');
      await walk(io, joinPath(dir, e.name), childPrefix, depth + 1, opts, out, counts);
    }
  }
}

export default defineCommand(treeCommand);
export { treeCommand };
