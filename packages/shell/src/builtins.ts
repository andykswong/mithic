/**
 * Shell builtins — commands that run in-process (no spawn), mutating shell
 * state (cwd, env, functions, jobs) and/or writing to the current stdout/stderr.
 */

/** Richer shell state surface a few builtins need (functions, jobs, positionals). */
export interface ShellState {
  functions: Map<string, { name: string; body: unknown }>;
  jobs: Array<{ id: number; pids: number[]; command: string; state: string; exitCode?: number }>;
  positional: string[];
  setPositional(p: string[]): void;
  shiftPositional(n: number): void;
  /** Mark a name as local to the current function scope. */
  declareLocal(name: string): void;
  /** Wait for a job/pid, returning its exit code. */
  waitJob(spec?: number): Promise<number>;
  waitAll(): Promise<number>;
  /** Toggle `set -e` errexit. */
  setErrExit(v: boolean): void;
  /** Set a shell option by its long name (errexit, nounset, xtrace, pipefail, noclobber). */
  setOption(name: ShellOptionName, value: boolean): void;
  /** Read a shell option's current value. */
  getOption(name: ShellOptionName): boolean;
  /** All options as [longName, enabled] pairs in canonical order. */
  listOptions(): Array<[ShellOptionName, boolean]>;
}

/** Long names of the shell options toggled via `set`. */
export type ShellOptionName = 'errexit' | 'nounset' | 'xtrace' | 'pipefail' | 'noclobber';

/** Map of `set -X` short flags ↔ long option names. */
export const OPTION_FLAGS: Record<string, ShellOptionName> = {
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  C: 'noclobber',
};

/** Mutable shell state + I/O hooks a builtin operates on. */
export interface BuiltinContext {
  cwd: string;
  env: Record<string, string>;
  write(s: string): void;
  writeErr?(s: string): void;
  exit?(code: number): void;
  eval?(src: string): Promise<number>;
  lastStatus?: number;
  stdin?: string;
  /** Loop/function control — implemented by the executor as thrown unwinds. */
  doBreak?(n: number): never;
  doContinue?(n: number): never;
  doReturn?(n: number): never;
  /** Richer state for local/declare/shift/getopts/jobs/wait. */
  state?: ShellState;
}

export const BUILTINS = [
  'cd', 'pwd', 'export', 'unset', 'echo', 'printf',
  'test', '[', 'true', 'false', 'exit', 'eval', 'set', 'cat', ':',
  'local', 'declare', 'readonly', 'shift', 'return', 'getopts', 'read',
  'jobs', 'fg', 'bg', 'wait', 'kill', 'break', 'continue', 'source', '.', 'type',
] as const;

const BUILTIN_SET = new Set<string>(BUILTINS);

export function isBuiltin(name: string): boolean {
  return BUILTIN_SET.has(name);
}

function errOut(ctx: BuiltinContext, s: string): void {
  (ctx.writeErr ?? ctx.write)(s);
}

function resolvePath(cwd: string, target: string): string {
  const base = target.startsWith('/') ? '' : cwd;
  const combined = `${base}/${target}`;
  const parts = combined.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { stack.pop(); continue; }
    stack.push(part);
  }
  return '/' + stack.join('/');
}

export async function runBuiltin(name: string, args: string[], ctx: BuiltinContext): Promise<number> {
  switch (name) {
    case ':':
    case 'true':
      return 0;

    case 'false':
      return 1;

    case 'cd': {
      const target = args[0] ?? ctx.env.HOME ?? '/';
      ctx.cwd = resolvePath(ctx.cwd, target);
      ctx.env.PWD = ctx.cwd;
      return 0;
    }

    case 'pwd':
      ctx.write(ctx.cwd + '\n');
      return 0;

    case 'echo': {
      let newline = true;
      let interpret = false;
      let start = 0;
      while (start < args.length && /^-[neE]+$/.test(args[start])) {
        if (args[start].includes('n')) newline = false;
        if (args[start].includes('e')) interpret = true;
        if (args[start].includes('E')) interpret = false;
        start++;
      }
      let s = args.slice(start).join(' ');
      if (interpret) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
      ctx.write(s + (newline ? '\n' : ''));
      return 0;
    }

    case 'printf':
      ctx.write(formatPrintf(args[0] ?? '', args.slice(1)));
      return 0;

    case 'export': {
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq > 0) ctx.env[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
      return 0;
    }

    case 'unset': {
      for (const arg of args) {
        delete ctx.env[arg];
        ctx.state?.functions.delete(arg);
      }
      return 0;
    }

    case 'local':
    case 'declare':
    case 'readonly': {
      // Assign NAME=value into the (function-local for `local`) env.
      const isLocal = name === 'local';
      for (const arg of args) {
        if (arg.startsWith('-')) continue; // ignore option flags (-i, -a, etc.)
        const eq = arg.indexOf('=');
        if (eq > 0) {
          const n = arg.slice(0, eq);
          if (isLocal) ctx.state?.declareLocal(n);
          ctx.env[n] = arg.slice(eq + 1);
        } else if (isLocal) {
          ctx.state?.declareLocal(arg);
          if (!(arg in ctx.env)) ctx.env[arg] = '';
        }
      }
      return 0;
    }

    case 'shift': {
      const n = args[0] !== undefined ? (parseInt(args[0], 10) || 0) : 1;
      ctx.state?.shiftPositional(n);
      return 0;
    }

    case 'return': {
      const code = args[0] !== undefined ? (parseInt(args[0], 10) || 0) : (ctx.lastStatus ?? 0);
      if (ctx.doReturn) ctx.doReturn(code);
      return code;
    }

    case 'break': {
      const n = args[0] !== undefined ? (parseInt(args[0], 10) || 1) : 1;
      if (ctx.doBreak) ctx.doBreak(n);
      return 0;
    }

    case 'continue': {
      const n = args[0] !== undefined ? (parseInt(args[0], 10) || 1) : 1;
      if (ctx.doContinue) ctx.doContinue(n);
      return 0;
    }

    case 'getopts': {
      return runGetopts(args, ctx);
    }

    case 'read': {
      return runRead(args, ctx);
    }

    case 'set':
      return runSet(args, ctx);

    case 'cat':
      ctx.write(ctx.stdin ?? '');
      return 0;

    case 'jobs': {
      const jobs = ctx.state?.jobs ?? [];
      for (const j of jobs) {
        const sym = j.state === 'running' ? 'Running' : j.state === 'stopped' ? 'Stopped' : 'Done';
        ctx.write(`[${j.id}]  ${sym}\t${j.command}\n`);
      }
      return 0;
    }

    case 'fg':
    case 'bg': {
      // No TTY/job-control suspension in this runtime; fg waits for the job,
      // bg is a no-op acknowledgement. Honest limitation (see executor docs).
      const jobs = ctx.state?.jobs ?? [];
      if (jobs.length === 0) { errOut(ctx, `shell: ${name}: no current job\n`); return 1; }
      if (name === 'fg') {
        const spec = parseJobSpec(args[0]);
        return (await ctx.state?.waitJob(spec)) ?? 0;
      }
      return 0;
    }

    case 'wait': {
      if (!ctx.state) return 0;
      if (args.length === 0) return ctx.state.waitAll();
      let last = 0;
      for (const a of args) last = await ctx.state.waitJob(parseJobSpec(a));
      return last;
    }

    case 'kill':
      // Signal delivery is not supported by the runtime; report gracefully.
      errOut(ctx, 'shell: kill: signal delivery not supported in this runtime\n');
      return 1;

    case 'type': {
      let status = 0;
      for (const a of args) {
        if (ctx.state?.functions.has(a)) ctx.write(`${a} is a function\n`);
        else if (isBuiltin(a)) ctx.write(`${a} is a shell builtin\n`);
        else { errOut(ctx, `type: ${a}: not found\n`); status = 1; }
      }
      return status;
    }

    case 'source':
    case '.': {
      // Without a file system read here, treat args as an inline script for eval.
      if (ctx.eval) return ctx.eval(args.join(' '));
      return 0;
    }

    case 'test':
    case '[': {
      let a = args;
      if (name === '[') {
        if (a[a.length - 1] !== ']') { errOut(ctx, 'shell: [: missing `]\'\n'); return 2; }
        a = a.slice(0, -1);
      }
      return evalTest(a) ? 0 : 1;
    }

    case 'exit': {
      const code = args.length > 0 ? (parseInt(args[0], 10) || 0) : (ctx.lastStatus ?? 0);
      if (ctx.exit) ctx.exit(code);
      return code;
    }

    case 'eval': {
      const src = args.join(' ');
      if (ctx.eval) return ctx.eval(src);
      return 0;
    }

    default:
      errOut(ctx, `shell: ${name}: not a builtin\n`);
      return 127;
  }
}

function parseJobSpec(arg?: string): number | undefined {
  if (arg === undefined) return undefined;
  if (arg.startsWith('%')) return parseInt(arg.slice(1), 10);
  return parseInt(arg, 10);
}

/**
 * `set` — toggle shell options and/or set positional params.
 *
 *   set -e/-u/-x/-C  +e/+u/+x/+C   short option flags (errexit, nounset,
 *                                  xtrace, noclobber)
 *   set -o NAME / +o NAME          long option by name (also pipefail)
 *   set -o / set +o                list option states (`+o` as re-settable cmds)
 *   set -- a b c                   replace positional params
 *   set a b c                      replace positional params (no leading dash)
 */
function runSet(args: string[], ctx: BuiltinContext): number {
  const st = ctx.state;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { st?.setPositional(args.slice(i + 1)); return 0; }
    if (arg !== '' && (arg[0] === '-' || arg[0] === '+')) {
      const enable = arg[0] === '-';
      const body = arg.slice(1);
      if (body === 'o' || body === '') {
        // `-o NAME` / `+o NAME`, or bare `-o`/`+o` to list.
        const name = args[i + 1];
        if (name === undefined) { listOptions(ctx, enable); return 0; }
        if (!setLongOption(ctx, name, enable)) {
          errOut(ctx, `shell: set: ${name}: invalid option name\n`);
          return 2;
        }
        i++; // consumed NAME
        continue;
      }
      // Cluster of short flags, e.g. `-eux`.
      for (const ch of body) {
        const long = OPTION_FLAGS[ch];
        if (!long) { errOut(ctx, `shell: set: -${ch}: invalid option\n`); return 2; }
        st?.setOption(long, enable);
      }
      continue;
    }
    // First non-flag operand: the rest are positional params.
    st?.setPositional(args.slice(i));
    return 0;
  }
  return 0;
}

function setLongOption(ctx: BuiltinContext, name: string, value: boolean): boolean {
  const valid = ['errexit', 'nounset', 'xtrace', 'pipefail', 'noclobber'];
  if (!valid.includes(name)) return false;
  ctx.state?.setOption(name as ShellOptionName, value);
  return true;
}

function listOptions(ctx: BuiltinContext, dashForm: boolean): void {
  const opts = ctx.state?.listOptions() ?? [];
  for (const [name, on] of opts) {
    // `set -o` prints `name<TAB>on|off`; `set +o` prints re-settable commands.
    if (dashForm) ctx.write(`${name}\t${on ? 'on' : 'off'}\n`);
    else ctx.write(`set ${on ? '-o' : '+o'} ${name}\n`);
  }
}

/** getopts OPTSTRING NAME — POSIX option parser using OPTIND/OPTARG in env. */
function runGetopts(args: string[], ctx: BuiltinContext): number {
  const optstring = args[0] ?? '';
  const varName = args[1] ?? '';
  const params = args.length > 2 ? args.slice(2) : (ctx.state?.positional ?? []);
  let optind = parseInt(ctx.env.OPTIND ?? '1', 10) || 1;

  if (optind > params.length) { ctx.env[varName] = '?'; return 1; }
  const arg = params[optind - 1];
  if (arg === undefined || arg[0] !== '-' || arg === '-') { ctx.env[varName] = '?'; return 1; }
  if (arg === '--') { ctx.env.OPTIND = String(optind + 1); ctx.env[varName] = '?'; return 1; }

  // single-letter cluster handling via OPTPOS
  let pos = parseInt(ctx.env.OPTPOS ?? '1', 10) || 1;
  const opt = arg[pos];
  const idx = optstring.indexOf(opt);
  if (idx < 0) {
    ctx.env[varName] = '?';
    ctx.env.OPTARG = opt;
    pos++;
    if (pos >= arg.length) { optind++; pos = 1; }
    ctx.env.OPTIND = String(optind); ctx.env.OPTPOS = String(pos);
    return 0;
  }
  if (optstring[idx + 1] === ':') {
    // takes an argument
    let optarg: string;
    if (pos + 1 < arg.length) { optarg = arg.slice(pos + 1); optind++; }
    else { optarg = params[optind] ?? ''; optind += 2; }
    ctx.env[varName] = opt;
    ctx.env.OPTARG = optarg;
    ctx.env.OPTIND = String(optind); ctx.env.OPTPOS = '1';
    return 0;
  }
  ctx.env[varName] = opt;
  delete ctx.env.OPTARG;
  pos++;
  if (pos >= arg.length) { optind++; pos = 1; }
  ctx.env.OPTIND = String(optind); ctx.env.OPTPOS = String(pos);
  return 0;
}

/** read [-r] NAME... — read one line from stdin, split on IFS into NAMEs. */
function runRead(args: string[], ctx: BuiltinContext): number {
  const names = args.filter((a) => !a.startsWith('-'));
  const stdin = ctx.stdin ?? '';
  const nl = stdin.indexOf('\n');
  const line = nl >= 0 ? stdin.slice(0, nl) : stdin;
  if (stdin === '') return 1; // EOF
  const fields = line.split(/\s+/).filter((f) => f !== '');
  if (names.length === 0) { ctx.env.REPLY = line; return 0; }
  for (let i = 0; i < names.length; i++) {
    if (i === names.length - 1) ctx.env[names[i]] = fields.slice(i).join(' ');
    else ctx.env[names[i]] = fields[i] ?? '';
  }
  return 0;
}

function evalTest(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== '';
  if (args.length === 2) {
    const [op, s] = args;
    switch (op) {
      case '-z': return s === '';
      case '-n': return s !== '';
      case '!': return !evalTest([s]);
      default: return true;
    }
  }
  if (args.length === 3) {
    const [a, op, b] = args;
    switch (op) {
      case '=':
      case '==': return a === b;
      case '!=': return a !== b;
      case '-eq': return Number(a) === Number(b);
      case '-ne': return Number(a) !== Number(b);
      case '-lt': return Number(a) < Number(b);
      case '-le': return Number(a) <= Number(b);
      case '-gt': return Number(a) > Number(b);
      case '-ge': return Number(a) >= Number(b);
      default: return false;
    }
  }
  if (args[0] === '!') return !evalTest(args.slice(1));
  return false;
}

/**
 * GNU/bash-compatible printf. Supports:
 *   - conversions: %s %b %c %d %i %u %o %x %X %f %e %E %g %G %%
 *   - flags `-` (left), `+` (sign), space, `0` (zero-pad), `#` (alt)
 *   - width and precision, including `*` taking them from args
 *   - format-string recycling: extra args reapply the format
 *   - escapes in the format: \n \t \r \\ \a \b \f \v \" \xNN \0nnn \nnn
 *   - %b interprets escapes in the ARGUMENT
 *   - integer args: leading-`'`/`"` char code, 0x hex, 0 octal, or decimal
 */
function formatPrintf(format: string, args: string[]): string {
  const fmt = interpretEscapes(format, /*octalBackslashZero*/ true);
  let out = '';
  let argi = 0;
  const nextArg = (): string => args[argi++] ?? '';
  // A single pass over the format; repeat while args remain and the format
  // consumed at least one conversion (recycling). `consumedConversion` guards
  // against infinite loops on formats with no conversions.
  do {
    const startArgi = argi;
    let consumedConversion = false;
    let i = 0;
    while (i < fmt.length) {
      const c = fmt[i];
      if (c !== '%') { out += c; i++; continue; }
      if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
      // Parse a conversion spec: %[flags][width][.precision]conv
      const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([sbcdiuoxXeEfgG])/.exec(fmt.slice(i));
      if (!m) { out += c; i++; continue; } // lone % with no valid conversion
      consumedConversion = true;
      const [whole, flags] = m;
      let width = m[2];
      let prec = m[3];
      if (width === '*') width = String(parseInt(nextArg(), 10) || 0);
      if (prec === '*') prec = String(parseInt(nextArg(), 10) || 0);
      const conv = m[4];
      out += formatOne(conv, flags, width ? parseInt(width, 10) : undefined,
        prec !== undefined ? parseInt(prec, 10) : undefined, nextArg());
      i += whole.length;
    }
    if (!consumedConversion) break;           // no conversions ⇒ print once
    if (argi === startArgi) break;            // conversions but consumed no args ⇒ stop
  } while (argi < args.length);
  return out;
}

/** Format a single conversion. `arg` is the raw string argument. */
function formatOne(conv: string, flags: string, width: number | undefined, prec: number | undefined, arg: string): string {
  const left = flags.includes('-');
  const zero = flags.includes('0') && !left;
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');

  let body: string;
  let signPrefix = '';

  switch (conv) {
    case 's': {
      body = arg;
      if (prec !== undefined) body = body.slice(0, prec);
      return pad(body, width, left, false);
    }
    case 'b': {
      body = interpretEscapes(arg, /*octalBackslashZero*/ false);
      if (prec !== undefined) body = body.slice(0, prec);
      return pad(body, width, left, false);
    }
    case 'c': {
      body = arg.slice(0, 1);
      return pad(body, width, left, false);
    }
    case 'd': case 'i': case 'u': {
      let v = parseIntArg(arg);
      if (conv === 'u' && v < 0) v = v >>> 0;
      const neg = v < 0;
      let digits = Math.abs(v).toString(10);
      if (prec !== undefined) { digits = digits.padStart(prec, '0'); if (prec === 0 && v === 0) digits = ''; }
      signPrefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      body = digits;
      return padNum(signPrefix, body, width, left, zero && prec === undefined);
    }
    case 'o': case 'x': case 'X': {
      let v = parseIntArg(arg);
      if (v < 0) v = v >>> 0;
      let digits = v.toString(conv === 'o' ? 8 : 16);
      if (conv === 'X') digits = digits.toUpperCase();
      if (prec !== undefined) { digits = digits.padStart(prec, '0'); if (prec === 0 && v === 0) digits = ''; }
      let altPrefix = '';
      if (alt && v !== 0) altPrefix = conv === 'o' ? '0' : conv === 'x' ? '0x' : '0X';
      body = digits;
      return padNum(altPrefix, body, width, left, zero && prec === undefined);
    }
    case 'f': case 'e': case 'E': case 'g': case 'G': {
      const num = parseFloatArg(arg);
      const p = prec ?? 6;
      let s: string;
      if (conv === 'f') s = Math.abs(num).toFixed(p);
      else if (conv === 'e' || conv === 'E') s = formatExp(Math.abs(num), p, conv === 'E');
      else s = formatG(Math.abs(num), prec === undefined ? 6 : (prec === 0 ? 1 : prec), conv === 'G', alt);
      const neg = num < 0 || Object.is(num, -0);
      signPrefix = neg ? '-' : plus ? '+' : space ? ' ' : '';
      body = s;
      return padNum(signPrefix, body, width, left, zero);
    }
    default:
      return '';
  }
}

/** Left/right pad a plain string to `width`. */
function pad(s: string, width: number | undefined, left: boolean, _zero: boolean): string {
  if (width === undefined || s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return left ? s + fill : fill + s;
}

/** Pad a numeric body that has a sign/prefix, honoring zero-fill between them. */
function padNum(prefix: string, body: string, width: number | undefined, left: boolean, zero: boolean): string {
  const total = prefix.length + body.length;
  if (width === undefined || total >= width) return prefix + body;
  const fillLen = width - total;
  if (left) return prefix + body + ' '.repeat(fillLen);
  if (zero) return prefix + '0'.repeat(fillLen) + body;
  return ' '.repeat(fillLen) + prefix + body;
}

/** `%e` formatting: mantissa + e±NN (≥2 exponent digits). */
function formatExp(n: number, prec: number, upper: boolean): string {
  let s = n.toExponential(prec); // e.g. "1.234500e+4"
  s = s.replace(/e([+-])(\d)$/, 'e$10$2'); // pad exponent to 2 digits
  return upper ? s.toUpperCase() : s;
}

/** `%g` formatting: shortest of %e/%f, trailing zeros trimmed unless `#`. */
function formatG(n: number, sig: number, upper: boolean, alt: boolean): string {
  if (n === 0) return alt ? '0.' + '0'.repeat(Math.max(0, sig - 1)) : '0';
  const exp = Math.floor(Math.log10(n));
  let s: string;
  if (exp < -4 || exp >= sig) {
    s = formatExp(n, sig - 1, upper);
    if (!alt) s = s.replace(/\.?0+e/, 'e');
  } else {
    s = n.toFixed(Math.max(0, sig - 1 - exp));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

/** Parse a printf integer argument: `'c` char code, 0x hex, 0 octal, decimal. */
function parseIntArg(arg: string): number {
  const s = arg.trim();
  if (s[0] === '\'' || s[0] === '"') return s.codePointAt(1) ?? 0;
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^[+-]?0[0-7]+$/.test(s)) return parseInt(s, 8);
  const v = parseInt(s, 10);
  return Number.isNaN(v) ? 0 : v;
}

function parseFloatArg(arg: string): number {
  const s = arg.trim();
  if (s[0] === '\'' || s[0] === '"') return s.codePointAt(1) ?? 0;
  const v = parseFloat(s);
  return Number.isNaN(v) ? 0 : v;
}

/**
 * Interpret backslash escapes. When `octalBackslashZero` is true (printf format
 * strings), octal is written `\0nnn`; for `%b` arguments it is `\nnn`.
 */
function interpretEscapes(s: string, octalBackslashZero: boolean): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') { out += s[i]; i++; continue; }
    const next = s[i + 1];
    switch (next) {
      case 'n': out += '\n'; i += 2; continue;
      case 't': out += '\t'; i += 2; continue;
      case 'r': out += '\r'; i += 2; continue;
      case 'a': out += '\x07'; i += 2; continue;
      case 'b': out += '\b'; i += 2; continue;
      case 'f': out += '\f'; i += 2; continue;
      case 'v': out += '\v'; i += 2; continue;
      case '\\': out += '\\'; i += 2; continue;
      case '"': out += '"'; i += 2; continue;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue; }
        out += '\\x'; i += 2; continue;
      }
      default: break;
    }
    // Octal in a printf FORMAT: `\0nnn` (1–3 octal digits after the 0) or, as a
    // GNU extension, a bare `\nnn`.
    if (octalBackslashZero && next === '0') {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 2));
      const oct = m ? m[0] : '';
      out += String.fromCharCode(parseInt(oct || '0', 8));
      i += 2 + oct.length; continue;
    }
    // Octal in a `%b` argument: `\nnn` (and `\0nnn`). Also bare `\nnn` in formats.
    if (/[0-7]/.test(next ?? '')) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      const oct = m ? m[0] : '0';
      out += String.fromCharCode(parseInt(oct, 8));
      i += 1 + oct.length; continue;
    }
    // Unknown escape: keep the backslash literally.
    out += '\\'; i += 1;
  }
  return out;
}
