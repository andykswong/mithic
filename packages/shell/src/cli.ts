/**
 * Shell CLI / argv front-end (H1).
 *
 * Parses the shell's argument vector the way `sh`/`bash` do, separating option
 * flags from the script source and positional parameters. This is a thin,
 * pure adapter over the otherwise-capable {@link Executor} — it decides WHAT to
 * run (a `-c` string, a script file, or stdin) and WHICH options to pre-set,
 * but does not itself interpret shell syntax.
 *
 *   sh [options] [-c command-string [name [args...]] | file [args...]]
 *
 * Recognised options: `-c`, `-s`, `-e`, `-u`, `-x`, `-v`, `-C`, clustered short
 * flags (`-eux`), `--posix`, `--version`, `--help`, and `--` (end of options).
 */
import type { ShellOptionName } from './builtins.ts';

export const VERSION = 'sh (mithic shell) 0.1.0';

export const HELP = [
  'Usage: sh [options] [script] [args...]',
  '  -c string   execute command string',
  '  -s          read commands from stdin',
  '  -e          exit on error',
  '  -u          error on unset variable',
  '  -x          trace commands',
  '  -v          verbose (print input lines)',
  '  -C          noclobber (do not overwrite files with >)',
  '  --posix     enable POSIX mode (disable bash extensions)',
  '  --version   print version',
  '  --help      print this help',
].join('\n') + '\n';

/** Short flag → long option name for the CLI front-end. */
const FLAGS: Record<string, ShellOptionName> = {
  e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', C: 'noclobber',
};

export interface CliResult {
  /** Options to enable before running. */
  options: ShellOptionName[];
  /** POSIX mode requested via --posix. */
  posix: boolean;
  /** When set, run this command string (from `-c`). */
  commandString?: string;
  /** When set, run this script file path. */
  scriptFile?: string;
  /** Read commands from stdin (no -c, no file, or explicit -s). */
  fromStdin: boolean;
  /** $0 override (the shell/script name shown in `$0` and diagnostics). */
  name?: string;
  /** Positional parameters ($1..$N). */
  positional: string[];
  /** Terminal action: print version/help and exit 0 (no script run). */
  action?: 'version' | 'help';
  /** A parse error message (unknown flag, missing -c arg). */
  error?: string;
}

/**
 * Parse the shell argv (everything AFTER argv0). `argv0` is the program name,
 * used as the default `$0` and for `sh`-name POSIX gating. `env` supplies
 * `POSIXLY_CORRECT` for activation.
 */
export function parseCliArgs(args: string[], argv0 = 'sh', env: Record<string, string> = {}): CliResult {
  const result: CliResult = { options: [], posix: false, fromStdin: false, positional: [], name: basename(argv0) };

  // POSIXLY_CORRECT or argv0 == 'sh' activates POSIX mode.
  if ('POSIXLY_CORRECT' in env || basename(argv0) === 'sh') result.posix = true;

  let i = 0;
  let endOfOptions = false;
  let sawScript = false;
  let sawDashS = false;

  while (i < args.length) {
    const arg = args[i];
    if (endOfOptions) { collectScriptOrPositional(result, arg, sawScript); sawScript = true; i++; continue; }

    if (arg === '--') { endOfOptions = true; i++; continue; }
    if (arg === '--version') { result.action = 'version'; return result; }
    if (arg === '--help') { result.action = 'help'; return result; }
    if (arg === '--posix') { result.posix = true; i++; continue; }
    if (arg === '-c') {
      i++;
      if (i >= args.length) { result.error = `${result.name}: -c: option requires an argument`; return result; }
      result.commandString = args[i]; i++;
      // Remaining: first → $0 override, rest → positionals.
      if (i < args.length) { result.name = args[i]; i++; }
      while (i < args.length) { result.positional.push(args[i]); i++; }
      return result;
    }
    if (arg === '-s') { sawDashS = true; i++; continue; }
    if (arg.length > 1 && arg[0] === '-' && arg[1] !== '-') {
      // clustered short flags, e.g. -eux
      for (const ch of arg.slice(1)) {
        if (ch === 's') { sawDashS = true; continue; }
        const long = FLAGS[ch];
        if (!long) { result.error = `${result.name}: -${ch}: invalid option`; return result; }
        if (!result.options.includes(long)) result.options.push(long);
      }
      i++;
      continue;
    }
    // First non-option arg is the script file; the rest are positionals.
    result.scriptFile = arg; sawScript = true; i++;
    while (i < args.length) { result.positional.push(args[i]); i++; }
    return result;
  }

  if (result.commandString === undefined && result.scriptFile === undefined) {
    result.fromStdin = true;
  }
  if (sawDashS) result.fromStdin = true;
  return result;
}

function collectScriptOrPositional(result: CliResult, arg: string, sawScript: boolean): void {
  if (!sawScript && result.scriptFile === undefined && result.commandString === undefined) {
    result.scriptFile = arg;
  } else {
    result.positional.push(arg);
  }
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}
