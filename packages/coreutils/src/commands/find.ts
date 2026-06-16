/**
 * `find` — walk a directory tree and print paths matching predicates.
 *   PATH...                : starting points (default `.`)
 *   -name GLOB             : match basename against a shell glob (* ? [..])
 *   -iname GLOB            : case-insensitive -name
 *   -path GLOB             : match the whole path against a glob
 *   -type f|d|l            : restrict by type (file / directory / symlink)
 *   -maxdepth N / -mindepth N : limit traversal depth (start path = depth 0)
 *   -print                 : print matches (implicit when no action given)
 *
 * NOTE: `-exec` is intentionally DEFERRED in this batch (printing only). The
 * traversal is iterative DFS over fs/readdir + fs/stat.
 */
import { defineCommand, writeLine } from '../harness.ts';
import { readdir, typeOf, joinPath, basename, normalize } from '../fs.ts';
import type { FileType } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

interface Filters {
  name?: RegExp;
  path?: RegExp;
  type?: FileType;
  maxdepth?: number;
  mindepth?: number;
}

/** Translate a shell glob into an anchored RegExp. */
function globToRegExp(glob: string, flags = ''): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      // character class — copy until the matching ']'
      let j = i + 1;
      let cls = '[';
      if (glob[j] === '!') { cls += '^'; j++; }
      while (j < glob.length && glob[j] !== ']') { cls += glob[j]; j++; }
      cls += ']';
      re += cls;
      i = j;
    } else if ('.+^${}()|\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', flags);
}

const TYPE_OF_CHAR: Record<string, FileType> = { f: 'file', d: 'directory', l: 'symlink' };

const findCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const argv = io.args.slice(1);
  const starts: string[] = [];
  const filters: Filters = {};

  // find's grammar is positional: paths come first, then predicates.
  let i = 0;
  while (i < argv.length && !argv[i].startsWith('-')) { starts.push(argv[i]); i++; }
  if (starts.length === 0) starts.push('.');

  const err = io.stderr.getWriter();
  const out = io.stdout.getWriter();
  let code = 0;

  try {
    for (; i < argv.length; i++) {
      const a = argv[i];
      switch (a) {
        case '-name': filters.name = globToRegExp(argv[++i] ?? ''); break;
        case '-iname': filters.name = globToRegExp(argv[++i] ?? '', 'i'); break;
        case '-path': case '-wholename': filters.path = globToRegExp(argv[++i] ?? ''); break;
        case '-type': filters.type = TYPE_OF_CHAR[argv[++i] ?? '']; break;
        case '-maxdepth': filters.maxdepth = parseInt(argv[++i] ?? '', 10); break;
        case '-mindepth': filters.mindepth = parseInt(argv[++i] ?? '', 10); break;
        case '-print': break; // default action
        case '-exec':
          await writeLine(err, 'find: -exec is not supported in this build');
          return 1;
        default:
          await writeLine(err, `find: unknown predicate '${a}'`);
          return 1;
      }
    }

    for (const start of starts) {
      try {
        await walk(io, normalize(start), 0, filters, out);
      } catch (e) {
        await writeLine(err, `find: '${start}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

function matches(path: string, type: FileType, depth: number, f: Filters): boolean {
  if (f.mindepth !== undefined && depth < f.mindepth) return false;
  if (f.type !== undefined && type !== f.type) return false;
  if (f.name && !f.name.test(basename(path))) return false;
  if (f.path && !f.path.test(path)) return false;
  return true;
}

async function walk(
  io: CommandIO, path: string, depth: number, f: Filters,
  out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const type = await typeOf(io, path, false);
  if (type === undefined) throw new Error('No such file or directory');

  if (matches(path, type, depth, f)) await writeLine(out, path);

  if (type === 'directory') {
    if (f.maxdepth !== undefined && depth >= f.maxdepth) return;
    let entries;
    try { entries = await readdir(io, path); } catch { return; }
    // Sort for deterministic output.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await walk(io, joinPath(path, entry.name), depth + 1, f, out);
    }
  }
}

export default defineCommand(findCommand);
export { findCommand, globToRegExp };
