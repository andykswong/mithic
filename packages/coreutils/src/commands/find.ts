/**
 * `find` — walk a directory tree, evaluating an EXPRESSION per entry.
 *
 * The expression is a boolean grammar of TESTS, ACTIONS, and OPERATORS, matching
 * GNU find:
 *
 *   Operators (decreasing precedence):
 *     ( EXPR )                    grouping
 *     ! EXPR   -not EXPR          logical NOT
 *     EXPR1 EXPR2 / -a / -and     logical AND (implicit between adjacent terms)
 *     EXPR1 -o EXPR2 / -or        logical OR (short-circuits like `||`)
 *     EXPR1 , EXPR2               list: evaluate both, value is EXPR2's
 *
 *   Tests (return a boolean for the current entry):
 *     -name / -iname GLOB         basename glob (`*`/`?` do NOT cross `/`)
 *     -path / -wholename GLOB     whole-path glob (`*`/`?` DO cross `/`)
 *     -ipath / -iwholename GLOB   case-insensitive -path
 *     -type f|d|l                 restrict by type (comma list e.g. `f,d` = f OR d)
 *     -size N[bckMG]              size test (see parseSize)
 *     -empty                      zero-byte file / empty directory
 *     -newer FILE                 mtime strictly newer than FILE's
 *     -true / -false              constant true / false
 *     -prune                      true; don't descend into this directory
 *
 *   Actions (side effects; presence of ANY action suppresses the implicit -print):
 *     -print                      print path + `\n`
 *     -print0                     print path + NUL (for xargs -0)
 *     -printf FORMAT              render FORMAT per match (%p %f %h %P %d %s %y %m + escapes)
 *     -exec cmd... ;              run cmd once per match, `{}` → the match path
 *     -exec cmd... +              run cmd once with ALL matches appended
 *     -quit                       stop the whole traversal immediately (exit 0)
 *
 *   Global options (always true, position-independent):
 *     -maxdepth N / -mindepth N   limit traversal depth (start path = depth 0)
 *     -depth                      process a directory's contents before the
 *                                 directory itself (post-order traversal)
 *
 * The traversal is a recursive DFS over fs/readdir + fs/stat. Directory entries are
 * visited in sorted order for determinism (GNU uses raw readdir order). `-exec`
 * spawns the child via the `process/pipeline` syscall (same path xargs uses).
 */
import { defineCommand, writeBytes, writeLine, exitWith } from '../harness.ts';
import { readdir, stat, basename } from '../fs.ts';
import type { FileType, StatResult } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** A `-size` test: comparison (`+`/`-`/`=` exact) of a value in `unit` bytes. */
interface SizeTest { cmp: '+' | '-' | '='; n: number; unit: number; rounded: boolean; }

/** Parse a `-size` argument like `+1k`, `-512`, `0`, `100c`. */
function parseSize(arg: string): SizeTest | undefined {
  const m = /^([+-]?)(\d+)([bckMG]?)$/.exec(arg);
  if (!m) return undefined;
  const cmp = m[1] === '+' ? '+' : m[1] === '-' ? '-' : '=';
  const n = Number(m[2]);
  const suffix = m[3];
  const unit = suffix === 'c' ? 1 : suffix === 'k' ? 1024 : suffix === 'M' ? 1024 * 1024 : suffix === 'G' ? 1024 * 1024 * 1024 : 512;
  // GNU find rounds a file's size UP to the next whole unit for EVERY suffix
  // except `c` (exact bytes). So `-size 1k` matches any file in (0, 1024] bytes,
  // while `-size 100c` is an exact byte comparison.
  const rounded = suffix !== 'c';
  return { cmp, n, unit, rounded };
}

/** True if `bytes` satisfies the `-size` test under its unit/rounding. */
function sizeMatches(bytes: number, t: SizeTest): boolean {
  const units = t.rounded ? Math.ceil(bytes / t.unit) : Math.floor(bytes / t.unit);
  if (t.cmp === '+') return units > t.n;
  if (t.cmp === '-') return units < t.n;
  return units === t.n;
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

/** POSIX dirname over a find-style path (no `.`/`..` collapsing). */
function findDirname(path: string): string {
  const i = path.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return path.slice(0, i);
}

/** The entry a predicate/action is evaluated against during the walk. */
interface Entry {
  /** The path as find would print it (start operand + joined components). */
  path: string;
  st: StatResult;
  depth: number;
  /** The start operand this entry descends from (for %P relative-path stripping). */
  start: string;
  /** True when the directory has no children (for -empty). */
  isEmptyDir: boolean;
  /** Set true by `-prune` to stop the walk descending into this directory. */
  prune: boolean;
}

/** Shared per-run state threaded through evaluation. */
interface EvalCtx {
  io: CommandIO;
  out: WritableStreamDefaultWriter<Uint8Array>;
  err: WritableStreamDefaultWriter<Uint8Array>;
  /** Paths collected by `-exec ... +` (batched, one spawn after the walk). */
  execBatch: Map<ExecNode, string[]>;
  /** True once `-quit` has fired — the whole traversal stops. */
  quit: boolean;
}

/** Thrown by the `-quit` action to unwind the recursive DFS immediately. */
class QuitWalk {}

// ── Expression AST ────────────────────────────────────────────────────────────

/**
 * An expression node evaluated per entry, returning its boolean value. Combinators
 * short-circuit like the shell (`-a`→`&&`, `-o`→`||`). Actions return true and have
 * side effects (print / exec). Nodes are plain closures (no `class` — the package's
 * `erasableSyntaxOnly` tsconfig forbids constructor parameter properties).
 */
interface EvalNode { evaluate(entry: Entry, ctx: EvalCtx): Promise<boolean>; }

/** An `-exec` action node: a command template plus a marker so batching can key on it. */
interface ExecNode extends EvalNode { readonly batch: boolean; readonly argv: string[]; }

const encoder = new TextEncoder();

const testNode = (fn: (e: Entry) => boolean): EvalNode => ({
  evaluate: async (entry) => fn(entry),
});

const notNode = (child: EvalNode): EvalNode => ({
  evaluate: async (entry, ctx) => !(await child.evaluate(entry, ctx)),
});

const andNode = (left: EvalNode, right: EvalNode): EvalNode => ({
  evaluate: async (entry, ctx) => (await left.evaluate(entry, ctx)) && right.evaluate(entry, ctx),
});

const orNode = (left: EvalNode, right: EvalNode): EvalNode => ({
  evaluate: async (entry, ctx) => (await left.evaluate(entry, ctx)) || right.evaluate(entry, ctx),
});

const commaNode = (left: EvalNode, right: EvalNode): EvalNode => ({
  evaluate: async (entry, ctx) => { await left.evaluate(entry, ctx); return right.evaluate(entry, ctx); },
});

const printNode = (sep: string): EvalNode => ({
  evaluate: async (entry, ctx) => { await writeBytes(ctx.out, encoder.encode(entry.path + sep)); return true; },
});

const printfNode = (format: string): EvalNode => ({
  evaluate: async (entry, ctx) => { await writeBytes(ctx.out, encoder.encode(renderPrintf(format, entry))); return true; },
});

/** `-quit` action: evaluates true, then unwinds the walk immediately (exit 0). */
const quitNode = (): EvalNode => ({
  evaluate: async (_entry, ctx) => { ctx.quit = true; throw new QuitWalk(); },
});

/**
 * `-prune`: always true; if the current entry is a directory, mark it so the walk
 * does not descend into it (has no effect on a non-directory). Not an action, so
 * it does not suppress the implicit `-print`.
 */
const pruneNode = (): EvalNode => ({
  evaluate: async (entry) => { if (entry.st.type === 'directory') entry.prune = true; return true; },
});

function execNode(argv: string[], batch: boolean): ExecNode {
  const node: ExecNode = {
    argv, batch,
    evaluate: async (entry, ctx) => {
      if (batch) {
        // Batched `-exec ... +`: defer to one spawn after the walk; keyed on this node.
        const list = ctx.execBatch.get(node) ?? [];
        list.push(entry.path);
        ctx.execBatch.set(node, list);
        return true;
      }
      // The `;` variant's child result affects only the predicate value — NOT
      // find's own exit code. Neither a nonzero child exit NOR a spawn FAILURE
      // (unresolvable command; runExec already emitted the stderr message)
      // changes find's exit status for the `;` variant (GNU exits 0). Only the
      // `+` variant propagates, and it does so via the batched runExec path.
      const code = await runExec(ctx.io, argv, [entry.path], ctx.out, ctx.err);
      return code === 0;
    },
  };
  return node;
}

/** Render a `-printf` format for one entry (%p %f %h %P %d %s %y %m + escapes). */
function renderPrintf(format: string, entry: Entry): string {
  const { path, st, depth, start } = entry;
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '\\' && i + 1 < format.length) {
      const next = format[++i];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r'
        : next === '\\' ? '\\' : next === '0' ? '\0' : next;
    } else if (c === '%' && i + 1 < format.length) {
      const spec = format[++i];
      if (spec === 'p') out += path;
      else if (spec === 'f') out += basename(path);
      else if (spec === 'h') out += findDirname(path);
      else if (spec === 'P') out += relativePath(path, start);
      else if (spec === 'd') out += String(depth);
      else if (spec === 's') out += String(st.size);
      else if (spec === 'y') out += typeChar(st.type);
      else if (spec === 'm') out += (st.mode & 0o7777).toString(8);
      else if (spec === '%') out += '%';
      else out += '%' + spec;
    } else {
      out += c;
    }
  }
  return out;
}

/** find's `%P`: the path with its start-point prefix (and one separator) removed. */
function relativePath(path: string, start: string): string {
  if (path === start) return '';
  const prefix = start.endsWith('/') ? start : start + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function typeChar(t: FileType): string {
  return t === 'directory' ? 'd' : t === 'symlink' ? 'l'
    : t === 'block-device' ? 'b' : t === 'character-device' ? 'c'
      : t === 'fifo' ? 'p' : t === 'socket' ? 's' : 'f';
}

// ── Expression parser ───────────────────────────────────────────────────────

/** Result of parsing the expression: an AST, whether it contains an action, plus depth options. */
interface ParsedExpr { node: EvalNode; hasAction: boolean; maxdepth?: number; mindepth?: number; depthFirst?: boolean; }

class ParseError extends Error {}

/**
 * Recursive-descent parser for find's expression grammar. Precedence, low→high:
 *   comma (`,`)  <  or (`-o`/`-or`)  <  and (`-a`/`-and`/implicit)  <  not (`!`/`-not`)  <  primary.
 * Depth options (`-maxdepth`/`-mindepth`) are global (always-true) and extracted
 * as they are seen. `hasAction` records whether any real action was parsed (so the
 * caller knows to suppress the implicit `-print`).
 */
class ExprParser {
  private readonly tokens: string[];
  private readonly io: CommandIO;
  private pos = 0;
  private hasAction = false;
  private maxdepth?: number;
  private mindepth?: number;
  private depthFirst = false;
  private newerCache = new Map<string, number>();

  constructor(tokens: string[], io: CommandIO) {
    this.tokens = tokens;
    this.io = io;
  }

  async parse(): Promise<ParsedExpr> {
    if (this.tokens.length === 0) {
      // Default expression is `-print`. Return a plain true predicate (NOT a
      // printNode): the driver wraps a no-action expression in the implicit
      // `-a -print`, so returning printNode here would print each entry twice.
      return { node: testNode(() => true), hasAction: false, maxdepth: this.maxdepth, mindepth: this.mindepth, depthFirst: this.depthFirst };
    }
    const node = await this.parseComma();
    if (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos];
      if (tok === ')') throw new ParseError('you have too many \')\'');
      throw new ParseError(`paths must precede expression: \`${tok}'`);
    }
    return { node, hasAction: this.hasAction, maxdepth: this.maxdepth, mindepth: this.mindepth, depthFirst: this.depthFirst };
  }

  private peek(): string | undefined { return this.tokens[this.pos]; }

  private async parseComma(): Promise<EvalNode> {
    let left = await this.parseOr();
    while (this.peek() === ',') {
      this.pos++;
      this.requireOperand(',');
      left = commaNode(left, await this.parseOr());
    }
    return left;
  }

  private async parseOr(): Promise<EvalNode> {
    let left = await this.parseAnd();
    while (this.peek() === '-o' || this.peek() === '-or') {
      const op = this.tokens[this.pos++];
      this.requireOperand(op);
      left = orNode(left, await this.parseAnd());
    }
    return left;
  }

  private async parseAnd(): Promise<EvalNode> {
    let left = await this.parseNot();
    for (;;) {
      const t = this.peek();
      if (t === '-a' || t === '-and') {
        this.pos++;
        this.requireOperand(t);
        left = andNode(left, await this.parseNot());
      } else if (t !== undefined && t !== ')' && t !== '-o' && t !== '-or' && t !== ',') {
        // implicit AND between two adjacent primaries
        left = andNode(left, await this.parseNot());
      } else {
        break;
      }
    }
    return left;
  }

  private async parseNot(): Promise<EvalNode> {
    const tok = this.peek();
    if (tok === '!' || tok === '-not') {
      this.pos++;
      this.requireOperand(tok);
      return notNode(await this.parseNot());
    }
    return this.parsePrimary();
  }

  private async parsePrimary(): Promise<EvalNode> {
    const tok = this.peek();
    if (tok === undefined) throw new ParseError('invalid expression; empty parentheses are not allowed.');
    if (tok === '(') {
      this.pos++;
      if (this.peek() === ')') throw new ParseError('invalid expression; empty parentheses are not allowed.');
      const inner = await this.parseComma();
      if (this.peek() !== ')') {
        throw new ParseError('invalid expression; I was expecting to find a \')\' somewhere but did not see one.');
      }
      this.pos++;
      return inner;
    }
    if (tok === ')') throw new ParseError('you have too many \')\'');
    if (tok === '-o' || tok === '-or' || tok === '-a' || tok === '-and' || tok === ',') {
      throw new ParseError(`invalid expression; you have used a binary operator '${tok}' with nothing before it.`);
    }
    return this.parseTestOrAction();
  }

  /**
   * After consuming a prefix/infix operator, the next token must begin an operand.
   * GNU distinguishes end-of-input (`expected an expression after '<op>'`) from a
   * closing paren (`expected an expression between '<op>' and ')'`).
   */
  private requireOperand(op: string): void {
    const t = this.peek();
    if (t === undefined) throw new ParseError(`expected an expression after '${op}'`);
    if (t === ')') throw new ParseError(`expected an expression between '${op}' and ')'`);
  }

  private next(): string { return this.tokens[this.pos++]; }

  private requireValue(pred: string): string {
    if (this.pos >= this.tokens.length) throw new ParseError(`missing argument to \`${pred}'`);
    return this.next();
  }

  private async parseTestOrAction(): Promise<EvalNode> {
    const pred = this.next();
    switch (pred) {
      case '-name': { const g = globToRegExp(this.requireValue(pred)); return testNode((e) => g.test(basename(e.path))); }
      case '-iname': { const g = globToRegExp(this.requireValue(pred), 'i'); return testNode((e) => g.test(basename(e.path))); }
      case '-path': case '-wholename': { const g = pathGlobToRegExp(this.requireValue(pred)); return testNode((e) => g.test(e.path)); }
      case '-ipath': case '-iwholename': { const g = pathGlobToRegExp(this.requireValue(pred), 'i'); return testNode((e) => g.test(e.path)); }
      case '-type': {
        const spec = this.requireValue(pred);
        const types = this.parseTypeList(spec);
        return testNode((e) => types.has(e.st.type));
      }
      case '-maxdepth': { this.maxdepth = this.parseDepth(pred, this.requireValue(pred)); return testNode(() => true); }
      case '-mindepth': { this.mindepth = this.parseDepth(pred, this.requireValue(pred)); return testNode(() => true); }
      case '-depth': { this.depthFirst = true; return testNode(() => true); }
      case '-size': {
        const t = parseSize(this.requireValue(pred));
        if (!t) throw new ParseError('invalid -size argument');
        return testNode((e) => e.st.type === 'file' && sizeMatches(e.st.size, t));
      }
      case '-empty': return testNode((e) =>
        (e.st.type === 'file' && e.st.size === 0) || (e.st.type === 'directory' && e.isEmptyDir));
      case '-newer': {
        const ref = this.requireValue(pred);
        const mtime = await this.statNewer(ref);
        return testNode((e) => new Date(e.st.mtime).getTime() > mtime);
      }
      case '-true': return testNode(() => true);
      case '-false': return testNode(() => false);
      case '-prune': return pruneNode();
      case '-print': this.hasAction = true; return printNode('\n');
      case '-print0': this.hasAction = true; return printNode('\0');
      case '-printf': { this.hasAction = true; return printfNode(this.requireValue(pred)); }
      case '-quit': this.hasAction = true; return quitNode();
      case '-exec': return this.parseExec();
      default:
        throw new ParseError(`unknown predicate \`${pred}'`);
    }
  }

  /** `-type f` or a comma list `f,d` (GNU 4.10). Each char must be a known type. */
  private parseTypeList(spec: string): Set<FileType> {
    const out = new Set<FileType>();
    for (const ch of spec.split(',')) {
      const t = TYPE_OF_CHAR[ch];
      if (ch.length !== 1 || !t) throw new ParseError(`Unknown argument to -type: ${ch === '' ? spec : ch}`);
      out.add(t);
    }
    return out;
  }

  /** A `-maxdepth`/`-mindepth` LEVELS value: a non-negative decimal integer. */
  private parseDepth(pred: string, value: string): number {
    if (!/^\d+$/.test(value)) {
      throw new ParseError(`Expected a positive decimal integer argument to ${pred}, but got ‘${value}’`);
    }
    return parseInt(value, 10);
  }

  private async statNewer(ref: string): Promise<number> {
    const cached = this.newerCache.get(ref);
    if (cached !== undefined) return cached;
    let mtime: number;
    try { mtime = new Date((await stat(this.io, ref, false)).mtime).getTime(); }
    catch { throw new ParseError(`‘${ref}’: No such file or directory`); }
    this.newerCache.set(ref, mtime);
    return mtime;
  }

  private parseExec(): ExecNode {
    const cmd: string[] = [];
    let batch = false;
    let terminated = false;
    while (this.pos < this.tokens.length) {
      const tok = this.next();
      if (tok === ';' || tok === '\\;') { terminated = true; break; }
      if (tok === '+') { batch = true; terminated = true; break; }
      cmd.push(tok);
    }
    if (!terminated || cmd.length === 0) throw new ParseError('missing argument to `-exec\'');
    this.hasAction = true;
    return execNode(cmd, batch);
  }
}

// ── exec spawning ───────────────────────────────────────────────────────────

/** Sentinel returned by {@link runExec} when the child could not be SPAWNED. */
const SPAWN_FAILED = -1;

/**
 * Run `template` with each `{}` replaced by the match path(s). With many paths
 * (batch mode) a single `{}` (or no `{}`) expands to all of them. Spawns via
 * `process/pipeline`; forwards child stdout. If the command cannot be spawned
 * (unresolvable name → the syscall rejects), GNU names it on stderr, continues
 * the walk, and sets find's exit status to 1 — so we emit that error and return
 * {@link SPAWN_FAILED} rather than letting the rejection escape the walk.
 */
async function runExec(
  io: CommandIO,
  template: string[],
  paths: string[],
  out: WritableStreamDefaultWriter<Uint8Array>,
  err: WritableStreamDefaultWriter<Uint8Array>,
): Promise<number> {
  const argv: string[] = [];
  let expanded = false;
  for (const tok of template) {
    if (tok === '{}') { argv.push(...paths); expanded = true; }
    else argv.push(tok);
  }
  if (!expanded) argv.push(...paths); // GNU appends matches if no {} given
  let result: { exitCodes: number[]; stdout?: Uint8Array };
  try {
    result = (await io.syscall('process/pipeline', {
      stages: [{ path: argv[0], argv }],
    })) as { exitCodes: number[]; stdout?: Uint8Array };
  } catch {
    await writeLine(err, `find: ‘${template[0]}’: No such file or directory`);
    return SPAWN_FAILED;
  }
  if (result.stdout && result.stdout.byteLength > 0) await writeBytes(out, result.stdout);
  return result.exitCodes?.[0] ?? 0;
}

// ── path handling ──────────────────────────────────────────────────────────

/**
 * GNU find prints a start operand VERBATIM (`find .` → `./…`, `find r/` keeps the
 * trailing slash on the start line) and joins children onto it with {@link joinPath}
 * (which already avoids a doubled `/`). So — unlike the old code — we do NOT
 * normalize the operand: `.`/`..`/`//`/trailing-`/` are all kept as typed, which
 * is exactly what a downstream `-exec {}` / `find | xargs` needs. An empty operand
 * (`find ''`) becomes `.`, matching GNU stat'ing the cwd for a "" argument.
 */
function normalizeStart(p: string): string {
  return p === '' ? '.' : p;
}

/**
 * Join a parent path and a child NAME the way find prints them: append directly
 * if the parent already ends in `/`, else insert one `/`. Unlike the shared
 * {@link import('../fs.ts').joinPath}, this does NOT special-case `.` — so a child
 * of the start operand `.` is printed as `./child` (GNU behavior), and `-exec`/
 * xargs receive a path that resolves the same way from the cwd.
 */
function findJoin(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

// ── driver ─────────────────────────────────────────────────────────────────

const findCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const argv = io.args.slice(1);
  const err = io.stderr.getWriter();
  const out = io.stdout.getWriter();

  try {
    // --version / --help are consumed before anything else (GNU exits 0).
    if (argv.includes('--help')) { await writeString(out, HELP); return 0; }
    if (argv.includes('--version')) { await writeString(out, VERSION); return 0; }

    // Leading global options -L/-H/-P set the symlink-follow policy and must be
    // consumed before path collection (they precede the paths in GNU's grammar).
    // -P is the no-follow default; -L follows all symlinks; -H follows only the
    // command-line operands. With no symlinks in the tree all three walk it
    // identically, so we accept them and (for now) always no-follow.
    let i = 0;
    while (i < argv.length && (argv[i] === '-L' || argv[i] === '-H' || argv[i] === '-P')) {
      i++;
    }

    // find's grammar is positional: PATH operands come first, then the expression.
    // A leading operand is a PATH unless it starts the expression: only `-…`
    // predicates, `(`, and `!` do that. GNU treats a leading `)` or `,` as a path
    // (it stat()s them), so those do NOT stop path collection.
    const starts: string[] = [];
    while (i < argv.length && !argv[i].startsWith('-') && argv[i] !== '(' && argv[i] !== '!') {
      starts.push(argv[i]);
      i++;
    }
    if (starts.length === 0) starts.push('.');

    let parsed: ParsedExpr;
    try {
      parsed = await new ExprParser(argv.slice(i), io).parse();
    } catch (e) {
      if (e instanceof ParseError) return exitWith(err, 1, `find: ${e.message}`);
      throw e;
    }

    // No explicit action → wrap the predicate in an implicit `-a -print`.
    const rootNode: EvalNode = parsed.hasAction
      ? parsed.node
      : andNode(parsed.node, printNode('\n'));

    const ctx: EvalCtx = { io, out, err, execBatch: new Map(), quit: false };
    let code = 0;
    for (const start of starts) {
      if (ctx.quit) break;
      const startPath = normalizeStart(start);
      try {
        await walk(io, startPath, 0, startPath, rootNode, parsed, ctx);
      } catch (e) {
        if (e instanceof QuitWalk) break;
        // GNU: `find: ‘<operand>’: No such file or directory` (fancy quotes).
        await writeLine(err, `find: ‘${start}’: No such file or directory`);
        code = 1;
      }
    }

    // Batched `-exec ... +`: one spawn per exec node with every collected match.
    for (const [node, paths] of ctx.execBatch) {
      if (paths.length === 0) continue;
      const childCode = await runExec(io, node.argv, paths, out, err);
      // The `+` variant DOES propagate a nonzero child (or spawn failure).
      if (childCode !== 0) code = 1;
    }
    return code;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

async function writeString(w: WritableStreamDefaultWriter<Uint8Array>, s: string): Promise<void> {
  await w.write(encoder.encode(s));
}

async function walk(
  io: CommandIO, path: string, depth: number, start: string,
  root: EvalNode, opts: ParsedExpr, ctx: EvalCtx,
): Promise<void> {
  let st: StatResult;
  try { st = await stat(io, path, false); } catch { throw new Error('No such file or directory'); }
  const type = st.type;

  let entries: { name: string; type: FileType }[] | undefined;
  if (type === 'directory') {
    try { entries = await readdir(io, path); } catch { entries = []; }
  }

  const entry: Entry = {
    path, st, depth, start,
    isEmptyDir: type === 'directory' && (entries?.length ?? 0) === 0,
    prune: false,
  };

  // -mindepth: entries shallower than mindepth are traversed but not evaluated.
  const evaluated = opts.mindepth === undefined || depth >= opts.mindepth;
  // Default is pre-order (a directory before its contents); `-depth` makes it
  // post-order (contents before the directory).
  if (evaluated && !opts.depthFirst) {
    await root.evaluate(entry, ctx);
  }

  if (!entry.prune && type === 'directory' && entries && !(opts.maxdepth !== undefined && depth >= opts.maxdepth)) {
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      await walk(io, findJoin(path, e.name), depth + 1, start, root, opts, ctx);
    }
  }

  if (evaluated && opts.depthFirst) {
    await root.evaluate(entry, ctx);
  }
}

const VERSION = `find (mithic coreutils) 2.0.0
`;

const HELP = `Usage: find [starting-point...] [expression]

Default path is the current directory; default expression is -print.

Operators (decreasing precedence):
      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2
      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2

Tests:  -name PATTERN -iname PATTERN -path PATTERN -type [bcdpfls]
        -size N[bckMG] -empty -newer FILE -true -false -prune

Global options (before paths): -L -H -P
Options: -maxdepth LEVELS -mindepth LEVELS -depth

Actions: -print -print0 -printf FORMAT -exec COMMAND ; -quit
`;

export default defineCommand(findCommand);
export { findCommand, globToRegExp, pathGlobToRegExp };
