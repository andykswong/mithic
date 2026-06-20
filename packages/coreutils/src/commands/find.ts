/**
 * `find` — walk a directory tree and print paths matching predicates.
 *   PATH...                : starting points (default `.`)
 *   -name GLOB             : match basename against a shell glob (* ? [..])
 *   -iname GLOB            : case-insensitive -name
 *   -path GLOB             : match the whole path against a glob (`*` crosses `/`)
 *   -type f|d|l            : restrict by type (file / directory / symlink)
 *   -maxdepth N / -mindepth N : limit traversal depth (start path = depth 0)
 *   -print                 : print matches (implicit when no action given)
 *   -exec cmd... ;         : run `cmd` once per match, `{}` → the match path
 *   -exec cmd... +         : run `cmd` once with ALL matches appended as args
 *
 * The traversal is iterative DFS over fs/readdir + fs/stat. `-exec` spawns the
 * child command through the `process/pipeline` syscall (same path xargs uses).
 */
import { defineCommand, writeBytes, writeLine } from '../harness.ts';
import { readdir, typeOf, joinPath, basename, normalize } from '../fs.ts';
import type { FileType } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** An -exec action: a command template with `{}` placeholders and a mode. */
interface ExecAction { argv: string[]; batch: boolean; }

interface Filters {
  name?: RegExp;
  path?: RegExp;
  type?: FileType;
  maxdepth?: number;
  mindepth?: number;
}

/**
 * Translate a shell glob into an anchored RegExp. `crossSlash` controls whether
 * `*`/`?` may match a `/`: false for `-name` (per-component, the default) and
 * true for `-path`/`-wholename` (whole-path matching, where `*` spans `/`).
 */
function compileGlob(glob: string, flags: string, crossSlash: boolean): RegExp {
  const star = crossSlash ? '.*' : '[^/]*';
  const any = crossSlash ? '.' : '[^/]';
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += star;
    else if (c === '?') re += any;
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

/** `-name` glob: `*`/`?` do NOT cross `/` (matched against a basename). */
function globToRegExp(glob: string, flags = ''): RegExp {
  return compileGlob(glob, flags, false);
}

/** `-path`/`-wholename` glob: `*`/`?` DO cross `/` (matched against a full path). */
function pathGlobToRegExp(glob: string, flags = ''): RegExp {
  return compileGlob(glob, flags, true);
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
  let exec: ExecAction | undefined;

  try {
    for (; i < argv.length; i++) {
      const a = argv[i];
      switch (a) {
        case '-name': filters.name = globToRegExp(argv[++i] ?? ''); break;
        case '-iname': filters.name = globToRegExp(argv[++i] ?? '', 'i'); break;
        case '-path': case '-wholename': filters.path = pathGlobToRegExp(argv[++i] ?? ''); break;
        case '-ipath': case '-iwholename': filters.path = pathGlobToRegExp(argv[++i] ?? '', 'i'); break;
        case '-type': filters.type = TYPE_OF_CHAR[argv[++i] ?? '']; break;
        case '-maxdepth': filters.maxdepth = parseInt(argv[++i] ?? '', 10); break;
        case '-mindepth': filters.mindepth = parseInt(argv[++i] ?? '', 10); break;
        case '-print': break; // default action
        case '-exec': {
          // Collect tokens until a `;`/`\;` (per-match) or `+` (batched) terminator.
          const cmd: string[] = [];
          i++;
          let batch = false;
          let terminated = false;
          for (; i < argv.length; i++) {
            const tok = argv[i];
            if (tok === ';' || tok === '\\;') { terminated = true; break; }
            if (tok === '+') { batch = true; terminated = true; break; }
            cmd.push(tok);
          }
          if (!terminated || cmd.length === 0) {
            await writeLine(err, 'find: missing argument to \'-exec\'');
            return 1;
          }
          exec = { argv: cmd, batch };
          break;
        }
        default:
          await writeLine(err, `find: unknown predicate '${a}'`);
          return 1;
      }
    }

    const ctx: WalkCtx = { exec, collected: [], execFailed: false };
    for (const start of starts) {
      try {
        await walk(io, normalize(start), 0, filters, out, ctx);
      } catch (e) {
        await writeLine(err, `find: '${start}': ${(e as Error).message}`);
        code = 1;
      }
    }

    // Batched `-exec ... +`: one spawn with every match appended.
    if (exec && exec.batch && ctx.collected.length > 0) {
      const childCode = await runExec(io, exec.argv, ctx.collected, out);
      if (childCode !== 0) code = 1;
    }
    // Per-match exec failures (any child returned non-zero).
    if (exec && !exec.batch && ctx.execFailed) code = 1;
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/** Per-traversal state for `-exec` (kept off module scope so it never leaks). */
interface WalkCtx { exec?: ExecAction; collected: string[]; execFailed: boolean; }

/**
 * Run `template` with each `{}` replaced by the match path(s). With many paths
 * (batch mode) a single `{}` (or no `{}`) expands to all of them. Spawns via
 * `process/pipeline`; forwards child stdout.
 */
async function runExec(
  io: CommandIO,
  template: string[],
  paths: string[],
  out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<number> {
  // Build argv: replace `{}` tokens. In batch mode a trailing `{}` expands to
  // all paths; otherwise each `{}` becomes the single path.
  const argv: string[] = [];
  let expanded = false;
  for (const tok of template) {
    if (tok === '{}') { argv.push(...paths); expanded = true; }
    else argv.push(tok);
  }
  if (!expanded) argv.push(...paths); // GNU appends matches if no {} given
  const result = (await io.syscall('process/pipeline', {
    stages: [{ path: argv[0], argv }],
  })) as { exitCodes: number[]; stdout?: Uint8Array };
  if (result.stdout && result.stdout.byteLength > 0) await writeBytes(out, result.stdout);
  return result.exitCodes?.[0] ?? 0;
}

function matches(path: string, type: FileType, depth: number, f: Filters): boolean {
  if (f.mindepth !== undefined && depth < f.mindepth) return false;
  if (f.type !== undefined && type !== f.type) return false;
  if (f.name && !f.name.test(basename(path))) return false;
  if (f.path && !f.path.test(path)) return false;
  return true;
}

async function walk(
  io: CommandIO, path: string, depth: number, f: Filters,
  out: WritableStreamDefaultWriter<Uint8Array>, ctx: WalkCtx,
): Promise<void> {
  const type = await typeOf(io, path, false);
  if (type === undefined) throw new Error('No such file or directory');

  if (matches(path, type, depth, f)) {
    if (!ctx.exec) {
      await writeLine(out, path); // default action: print
    } else if (ctx.exec.batch) {
      ctx.collected.push(path); // batched: defer to one spawn after the walk
    } else {
      const childCode = await runExec(io, ctx.exec.argv, [path], out);
      if (childCode !== 0) ctx.execFailed = true;
    }
  }

  if (type === 'directory') {
    if (f.maxdepth !== undefined && depth >= f.maxdepth) return;
    let entries;
    try { entries = await readdir(io, path); } catch { return; }
    // Sort for deterministic output.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      await walk(io, joinPath(path, entry.name), depth + 1, f, out, ctx);
    }
  }
}

export default defineCommand(findCommand);
export { findCommand, globToRegExp, pathGlobToRegExp };
