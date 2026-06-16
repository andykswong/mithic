/**
 * `stat` — display file status.
 *   -c / --format FMT : output FMT, expanding %-directives (see below)
 *   -L / --dereference: follow symlinks (stat the target)
 *   -t / --terse      : terse one-line output
 *
 * Supported format directives (subset of GNU stat):
 *   %n name   %s size   %f raw mode (hex)   %a access rights (octal)
 *   %F file type (human)   %h hard link count   %Y mtime (epoch s)
 *   %X atime (epoch s)   %Z ctime (epoch s)   %% literal percent
 */
import { defineCommand, parseArgs, writeLine } from '../harness.ts';
import { stat, normalize } from '../fs.ts';
import type { StatResult, FileType } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

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

const epochSeconds = (t: string | number | Date): number => Math.floor(new Date(t).getTime() / 1000);

/** Expand one `%X` directive against a stat result. */
function expand(spec: string, name: string, st: StatResult): string {
  switch (spec) {
    case 'n': return name;
    case 's': return String(st.size);
    case 'f': return (st.mode >>> 0).toString(16);
    case 'a': return (st.mode & 0o7777).toString(8);
    case 'F': return TYPE_NAMES[st.type] ?? 'unknown';
    case 'h': return String(st.linkCount);
    case 'Y': return String(epochSeconds(st.mtime));
    case 'X': return String(epochSeconds(st.atime));
    case 'Z': return String(epochSeconds(st.ctime));
    case '%': return '%';
    default: return '%' + spec;
  }
}

/** Apply a GNU-style format string, expanding %-directives and \n / \t escapes. */
function applyFormat(fmt: string, name: string, st: StatResult): string {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '%' && i + 1 < fmt.length) { out += expand(fmt[++i], name, st); }
    else if (c === '\\' && i + 1 < fmt.length) {
      const n = fmt[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else { out += c; }
  }
  return out;
}

/** Default (no -c) multi-line-ish summary. */
function defaultFormat(name: string, st: StatResult): string {
  const perms = (st.mode & 0o7777).toString(8).padStart(4, '0');
  return `  File: ${name}\n  Size: ${st.size}\tType: ${TYPE_NAMES[st.type] ?? 'unknown'}\n` +
    `Access: (${perms})  Links: ${st.linkCount}\nModify: ${epochSeconds(st.mtime)}`;
}

const statCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['L', 't'],
    string: ['c'],
    alias: { format: 'c', dereference: 'L', terse: 't' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let code = 0;
  const follow = Boolean(flags.L);

  try {
    if (positionals.length === 0) {
      await writeLine(err, 'stat: missing operand');
      return 1;
    }
    for (const file of positionals) {
      try {
        const st = await stat(io, normalize(file), follow);
        if (typeof flags.c === 'string') {
          await writeLine(out, applyFormat(flags.c, file, st));
        } else if (flags.t) {
          await writeLine(out, `${file} ${st.size} ${(st.mode >>> 0).toString(16)} ${st.linkCount} ${epochSeconds(st.mtime)}`);
        } else {
          await writeLine(out, defaultFormat(file, st));
        }
      } catch (e) {
        await writeLine(err, `stat: cannot stat '${file}': ${(e as Error).message}`);
        code = 1;
      }
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(statCommand);
export { statCommand, applyFormat };
