/**
 * Shell builtins — commands that run in-process (no spawn), mutating shell
 * state (cwd, env) and/or writing to the current stdout/stderr sink.
 *
 * The minimal set: cd, pwd, export, unset, echo, printf, test/`[`, true, false,
 * exit, eval, set. Each returns an exit code (number) or a Promise of one.
 */

/** Mutable shell state + I/O hooks a builtin operates on. */
export interface BuiltinContext {
  cwd: string;
  env: Record<string, string>;
  /** Write to stdout. */
  write(s: string): void;
  /** Write to stderr (defaults to {@link write} if absent). */
  writeErr?(s: string): void;
  /**
   * Signals process exit. The executor sets this so `exit` can unwind. If
   * absent, `exit` records the code on the context and returns it.
   */
  exit?(code: number): void;
  /** Re-enter the executor for `eval`. Set by the executor. */
  eval?(src: string): Promise<number>;
  /** Last command exit code, for `exit` with no args. */
  lastStatus?: number;
}

export const BUILTINS = [
  'cd',
  'pwd',
  'export',
  'unset',
  'echo',
  'printf',
  'test',
  '[',
  'true',
  'false',
  'exit',
  'eval',
  'set',
  ':',
] as const;

const BUILTIN_SET = new Set<string>(BUILTINS);

export function isBuiltin(name: string): boolean {
  return BUILTIN_SET.has(name);
}

function errOut(ctx: BuiltinContext, s: string): void {
  (ctx.writeErr ?? ctx.write)(s);
}

/** Resolve a (possibly relative) path against the current cwd. POSIX-style. */
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

export async function runBuiltin(
  name: string,
  args: string[],
  ctx: BuiltinContext,
): Promise<number> {
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
      let start = 0;
      if (args[0] === '-n') { newline = false; start = 1; }
      ctx.write(args.slice(start).join(' ') + (newline ? '\n' : ''));
      return 0;
    }

    case 'printf': {
      ctx.write(formatPrintf(args[0] ?? '', args.slice(1)));
      return 0;
    }

    case 'export': {
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq > 0) {
          ctx.env[arg.slice(0, eq)] = arg.slice(eq + 1);
        }
        // `export NAME` with no `=` is a no-op here (already in env or unset).
      }
      return 0;
    }

    case 'unset': {
      for (const arg of args) delete ctx.env[arg];
      return 0;
    }

    case 'set':
      // Minimal: ignore options. A full implementation handles `-e`, `--`, etc.
      return 0;

    case 'test':
    case '[': {
      let a = args;
      if (name === '[') {
        if (a[a.length - 1] !== ']') {
          errOut(ctx, 'shell: [: missing `]\'\n');
          return 2;
        }
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

/**
 * Evaluate a `test`/`[` expression. Supports the common unary/binary forms:
 *   -z s, -n s, -e f (treated like -n for the minimal VFS-less case),
 *   s1 = s2, s1 != s2, n1 -eq/-ne/-lt/-le/-gt/-ge n2, and bare string truthiness.
 */
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

/** Minimal printf supporting %s, %d, %%, and \n/\t escapes in the format. */
function formatPrintf(format: string, args: string[]): string {
  const fmt = format
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
  let argi = 0;
  return fmt.replace(/%[sd%]/g, (m) => {
    if (m === '%%') return '%';
    const v = args[argi++] ?? '';
    if (m === '%d') return String(parseInt(v, 10) || 0);
    return v;
  });
}
