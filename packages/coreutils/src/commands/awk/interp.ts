/**
 * Tree-walking interpreter for the POSIX awk language.
 *
 * The interpreter ({@link Interpreter}) is intentionally decoupled from the
 * kernel: it consumes a {@link Program}, a list of named input sources, and an
 * {@link AwkIO} sink for output and optional file/command I/O. This lets the
 * command entry ({@link import('../awk.ts')}) wire real `fs/*` syscalls while
 * unit tests drive it with plain strings — the interpreter never imports the
 * harness.
 *
 * Control flow that must unwind the JS call stack (next/nextfile/exit/break/
 * continue/return) is modeled with thrown {@link Signal} sentinels caught at the
 * appropriate boundary, rather than threading status codes through every node.
 *
 * `rand`/`srand` use a seeded mulberry32 PRNG (NOT `Math.random`) so output is
 * deterministic and reproducible; `srand()` with no arg seeds from a fixed
 * default (POSIX leaves the default unspecified; we choose 0 for determinism).
 */
import type {
  Program, Rule, Stmt, Expr, LValue,
} from './ast.ts';
import { toNum, toStr, toBool, looksNumeric, numToStr, sprintf } from './value.ts';
import type { Value } from './value.ts';

// ── output / external I/O sink ────────────────────────────────────────────────

/**
 * The side-effect surface the interpreter needs. `write` is normal stdout;
 * `writeErr` is stderr. The optional hooks back the redirect/getline forms; if a
 * hook is absent the corresponding feature reports an error at runtime.
 */
export interface AwkIO {
  write(text: string): void;
  writeErr(text: string): void;
  /** Open/append to a file for `print > file` / `print >> file`. */
  writeFile?(path: string, text: string, append: boolean): void;
  /** Read a whole file's text for `getline < file`; undefined if missing. */
  readFile?(path: string): string | undefined;
  /** Run `cmd` and return its stdout for `cmd | getline`; undefined if absent. */
  runCommand?(cmd: string): string | undefined;
  /** Send text to a command's stdin for `print | cmd`. */
  pipeToCommand?(cmd: string, text: string): void;
}

export interface AwkOptions {
  /** Initial field separator (`-F`); defaults to whitespace mode. */
  fs?: string;
  /** `-v var=val` assignments applied before BEGIN. */
  assigns?: Record<string, string>;
  /** ARGV file names (already expanded); used for FILENAME/ARGC/ARGV. */
  argv?: string[];
}

/** A named input source: its FILENAME and full text (already read). */
export interface InputSource { name: string; text: string; }

// ── control-flow signals ───────────────────────────────────────────────────────

const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');
const NEXT = Symbol('next');
const NEXTFILE = Symbol('nextfile');
class ExitSignal { constructor(public code: number) {} }
class ReturnSignal { constructor(public value: Value) {} }

type ArrayVal = Map<string, Value>;
/** A scalar variable or an associative array. */
type Cell = Value | ArrayVal;

function isArray(v: Cell | undefined): v is ArrayVal { return v instanceof Map; }

export class Interpreter {
  private program: Program;
  private io: AwkIO;
  private globals = new Map<string, Cell>();
  /** Per-call local scopes for user functions (innermost last). */
  private locals: Array<Map<string, Cell>> = [];

  private fields: string[] = []; // fields[0] is $0
  private record = '';
  private nf = 0;
  private exitCode = 0;
  private rangeActive: boolean[] = []; // per range-rule state
  private rng: () => number;
  private rngSeed = 0;

  // Files/commands opened for redirected output (so > truncates once, >> appends).
  private openWrites = new Set<string>();

  constructor(program: Program, io: AwkIO, opts: AwkOptions = {}) {
    this.program = program;
    this.io = io;
    // Special variables with their POSIX defaults.
    this.globals.set('FS', opts.fs ?? ' ');
    this.globals.set('OFS', ' ');
    this.globals.set('ORS', '\n');
    this.globals.set('RS', '\n');
    this.globals.set('SUBSEP', '\x1c');
    this.globals.set('NR', 0);
    this.globals.set('NF', 0);
    this.globals.set('FNR', 0);
    this.globals.set('RSTART', 0);
    this.globals.set('RLENGTH', -1);
    this.globals.set('CONVFMT', '%.6g');
    this.globals.set('OFMT', '%.6g');
    this.globals.set('FILENAME', '');
    this.rng = mulberry32(this.rngSeed);

    // ARGV/ARGC.
    const argv = opts.argv ?? [];
    const argvArr: ArrayVal = new Map();
    argvArr.set('0', 'awk');
    for (let k = 0; k < argv.length; k++) argvArr.set(String(k + 1), argv[k]);
    this.globals.set('ARGV', argvArr);
    this.globals.set('ARGC', argv.length + 1);

    // -v assignments (with escape processing) before BEGIN.
    for (const [k, v] of Object.entries(opts.assigns ?? {})) {
      this.globals.set(k, processEscapes(v));
    }

    // Initialize per-rule range state (inactive until a start pattern matches).
    this.program.rules.forEach((r, idx) => {
      if (r.pattern.type === 'range') this.rangeActive[idx] = false;
    });
  }

  /** Run the whole program over the given inputs; return the process exit code. */
  run(inputs: InputSource[]): number {
    try {
      this.runBegins();
      // If the program has only BEGIN rules and no main/END rules, awk does not
      // read input at all.
      const needsInput = this.program.rules.some((r) => r.pattern.type !== 'begin');
      if (needsInput) this.runMain(inputs);
      this.runEnds();
    } catch (sig) {
      if (sig instanceof ExitSignal) {
        this.exitCode = sig.code;
        // END rules still run on exit from BEGIN/main (unless already in END).
        try { this.runEnds(); } catch (e) { if (e instanceof ExitSignal) this.exitCode = e.code; else throw e; }
      } else {
        throw sig;
      }
    }
    return this.exitCode;
  }

  private endsRan = false;

  private runBegins(): void {
    for (const r of this.program.rules) {
      if (r.pattern.type === 'begin') this.execStmts(r.action ?? []);
    }
  }

  private runEnds(): void {
    if (this.endsRan) return;
    this.endsRan = true;
    for (const r of this.program.rules) {
      if (r.pattern.type === 'end') this.execStmts(r.action ?? []);
    }
  }

  private mainInputs: InputSource[] = [];
  private inputIndex = 0;
  private lineQueue: string[] = [];
  private lineQueuePos = 0;

  private runMain(inputs: InputSource[]): void {
    this.mainInputs = inputs.length > 0 ? inputs : [];
    for (this.inputIndex = 0; this.inputIndex < this.mainInputs.length; this.inputIndex++) {
      const src = this.mainInputs[this.inputIndex];
      this.globals.set('FILENAME', src.name);
      this.globals.set('FNR', 0);
      this.lineQueue = splitRecords(src.text, this.str('RS'));
      this.lineQueuePos = 0;
      let fileDone = false;
      while (!fileDone && this.lineQueuePos < this.lineQueue.length) {
        const line = this.lineQueue[this.lineQueuePos++];
        this.globals.set('NR', this.num('NR') + 1);
        this.globals.set('FNR', this.num('FNR') + 1);
        this.setRecord(line);
        try {
          this.runRules();
        } catch (sig) {
          if (sig === NEXT) continue;
          if (sig === NEXTFILE) { fileDone = true; continue; }
          throw sig;
        }
      }
    }
  }

  private runRules(): void {
    this.program.rules.forEach((rule, idx) => {
      if (rule.pattern.type === 'begin' || rule.pattern.type === 'end') return;
      if (this.matches(rule, idx)) {
        if (rule.action === undefined) {
          // pattern-only → implicit print $0
          this.io.write(this.fields[0] + this.str('ORS'));
        } else {
          this.execStmts(rule.action);
        }
      }
    });
  }

  private matches(rule: Rule, idx: number): boolean {
    const p = rule.pattern;
    switch (p.type) {
      case 'always': return true;
      case 'expr': return this.matchExprPattern(p.expr);
      case 'range': {
        if (!this.rangeActive[idx]) {
          if (this.matchExprPattern(p.start)) {
            this.rangeActive[idx] = true;
            // Single-line range: end matches the same line → close immediately.
            if (this.matchExprPattern(p.end)) this.rangeActive[idx] = false;
            return true;
          }
          return false;
        }
        // Already inside the range.
        if (this.matchExprPattern(p.end)) this.rangeActive[idx] = false;
        return true;
      }
      default: return false;
    }
  }

  /** A pattern expression is truthy; a bare regex matches against `$0`. */
  private matchExprPattern(e: Expr): boolean {
    if (e.type === 'regex') return this.compileRegex(e.source).test(this.fields[0]);
    return toBool(this.eval(e));
  }

  // ── records & fields ─────────────────────────────────────────────────────────

  private setRecord(line: string): void {
    this.record = line;
    this.fields = [line];
    this.splitFields();
  }

  private splitFields(): void {
    const fs = this.str('FS');
    const rec = this.record;
    let parts: string[];
    if (fs === ' ') {
      // Default: split on runs of whitespace, ignoring leading/trailing.
      const t = rec.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
      parts = t === '' ? [] : t.split(/[ \t\n]+/);
    } else if (fs === '\t') {
      parts = rec === '' ? [] : rec.split('\t');
    } else if (fs.length === 1) {
      // A single char (other than space) is a literal separator.
      parts = rec === '' ? [] : rec.split(fs === ']' || '\\^$.|?*+(){}['.includes(fs) ? new RegExp(escapeRe(fs)) : fs);
    } else {
      // Multi-char FS is an ERE.
      parts = rec === '' ? [] : rec.split(this.compileRegex(fs));
    }
    this.fields = [rec, ...parts];
    this.nf = parts.length;
    this.globals.set('NF', this.nf);
  }

  /** Rebuild `$0` from fields joined by OFS (after a field assignment). */
  private rebuildRecord(): void {
    const ofs = this.str('OFS');
    this.fields[0] = this.fields.slice(1, this.nf + 1).map((f) => f ?? '').join(ofs);
    this.record = this.fields[0];
  }

  private getField(i: number): Value {
    if (i === 0) return this.fields[0];
    if (i < 0) throw new Error('awk: field index negative');
    const v = this.fields[i];
    return v === undefined ? '' : v;
  }

  private setField(i: number, value: Value): void {
    const s = this.valToStr(value);
    if (i === 0) { this.setRecord(s); return; }
    if (i < 0) throw new Error('awk: field index negative');
    // Extend NF if assigning beyond the current last field.
    if (i > this.nf) {
      for (let k = this.nf + 1; k < i; k++) if (this.fields[k] === undefined) this.fields[k] = '';
      this.nf = i;
      this.globals.set('NF', this.nf);
    }
    this.fields[i] = s;
    this.rebuildRecord();
  }

  /** Set NF directly (truncates or extends the field list, rebuilds $0). */
  private setNF(n: number): void {
    n = Math.max(0, Math.trunc(n));
    if (n < this.nf) {
      this.fields.length = n + 1;
    } else {
      for (let k = this.nf + 1; k <= n; k++) if (this.fields[k] === undefined) this.fields[k] = '';
    }
    this.nf = n;
    this.globals.set('NF', n);
    this.rebuildRecord();
  }

  // ── variable access ────────────────────────────────────────────────────────

  private scopeFor(name: string): Map<string, Cell> {
    const local = this.locals[this.locals.length - 1];
    if (local && local.has(name)) return local;
    return this.globals;
  }

  private getVar(name: string): Value {
    const cell = this.scopeFor(name).get(name);
    if (isArray(cell)) {
      // An empty Map may be an as-yet-untyped name (e.g. an uninitialized arg
      // bound by reference); treat it as the uninitialized scalar "".
      if (cell.size === 0) return '';
      throw new Error(`awk: can't read array ${name} as scalar`);
    }
    return cell ?? '';
  }

  private setVar(name: string, value: Value): void {
    const scope = this.scopeFor(name);
    scope.set(name, value);
    if (scope === this.globals && name === 'NF') this.setNF(toNum(value));
  }

  private getArray(name: string): ArrayVal {
    const scope = this.scopeFor(name);
    let cell = scope.get(name);
    if (cell === undefined || cell === '') { cell = new Map(); scope.set(name, cell); }
    if (!isArray(cell)) throw new Error(`awk: can't use scalar ${name} as array`);
    return cell;
  }

  private str(name: string): string { return this.valToStr(this.getVar(name)); }
  private num(name: string): number { return toNum(this.getVar(name)); }

  private valToStr(v: Value): string { return toStr(v, this.convfmt()); }
  private convfmt(): string {
    const c = this.globals.get('CONVFMT');
    return typeof c === 'string' ? c : '%.6g';
  }

  // ── statement execution ────────────────────────────────────────────────────

  private execStmts(stmts: Stmt[]): void { for (const s of stmts) this.exec(s); }

  private exec(s: Stmt): void {
    switch (s.type) {
      case 'expr': this.eval(s.expr); return;
      case 'block': this.execStmts(s.body); return;
      case 'empty': return;
      case 'print': this.doPrint(s.args, s.redirect); return;
      case 'printf': this.doPrintf(s.args, s.redirect); return;
      case 'if':
        if (toBool(this.eval(s.cond))) this.exec(s.then);
        else if (s.else) this.exec(s.else);
        return;
      case 'while':
        while (toBool(this.eval(s.cond))) {
          try { this.exec(s.body); } catch (sig) { if (sig === BREAK) break; if (sig === CONTINUE) continue; throw sig; }
        }
        return;
      case 'dowhile':
        do {
          try { this.exec(s.body); } catch (sig) { if (sig === BREAK) break; if (sig === CONTINUE) continue; throw sig; }
        } while (toBool(this.eval(s.cond)));
        return;
      case 'for': {
        if (s.init) this.exec(s.init);
        while (s.cond === undefined || toBool(this.eval(s.cond))) {
          try { this.exec(s.body); }
          catch (sig) { if (sig === BREAK) break; if (sig !== CONTINUE) throw sig; }
          if (s.update) this.exec(s.update);
        }
        return;
      }
      case 'forin': {
        const arr = this.getArray(s.array);
        for (const key of [...arr.keys()]) {
          this.setVar(s.var, key);
          try { this.exec(s.body); } catch (sig) { if (sig === BREAK) break; if (sig === CONTINUE) continue; throw sig; }
        }
        return;
      }
      case 'next': throw NEXT;
      case 'nextfile': throw NEXTFILE;
      case 'break': throw BREAK;
      case 'continue': throw CONTINUE;
      case 'exit': throw new ExitSignal(s.code ? Math.trunc(toNum(this.eval(s.code))) : this.exitCode);
      case 'return': throw new ReturnSignal(s.value ? this.eval(s.value) : '');
      case 'delete': {
        const arr = this.getArray(s.name);
        if (s.indices) arr.delete(this.subscript(s.indices));
        else arr.clear();
        return;
      }
    }
  }

  private doPrint(args: Expr[], redirect?: { mode: '>' | '>>' | '|'; target: Expr }): void {
    const ofs = this.str('OFS');
    const ors = this.str('ORS');
    let text: string;
    if (args.length === 0) {
      text = this.fields[0];
    } else {
      text = args.map((a) => this.outputStr(this.eval(a))).join(ofs);
    }
    this.emit(text + ors, redirect);
  }

  private doPrintf(args: Expr[], redirect?: { mode: '>' | '>>' | '|'; target: Expr }): void {
    if (args.length === 0) return;
    const fmt = this.valToStr(this.eval(args[0]));
    const rest = args.slice(1).map((a) => this.eval(a));
    this.emit(sprintf(fmt, rest), redirect);
  }

  /** Stringify for `print` using OFMT for non-integer numbers. */
  private outputStr(v: Value): string {
    if (typeof v === 'number') {
      const ofmt = this.globals.get('OFMT');
      return numToStr(v, typeof ofmt === 'string' ? ofmt : '%.6g');
    }
    return v;
  }

  private emit(text: string, redirect?: { mode: '>' | '>>' | '|'; target: Expr }): void {
    if (!redirect) { this.io.write(text); return; }
    const target = this.valToStr(this.eval(redirect.target));
    if (redirect.mode === '|') {
      if (!this.io.pipeToCommand) { this.io.writeErr(`awk: print | "${target}" not supported\n`); return; }
      this.io.pipeToCommand(target, text);
      return;
    }
    if (!this.io.writeFile) { this.io.writeErr(`awk: print > "${target}" not supported\n`); return; }
    const append = redirect.mode === '>>' || this.openWrites.has(target);
    this.openWrites.add(target);
    this.io.writeFile(target, text, append);
  }

  // ── expression evaluation ──────────────────────────────────────────────────

  private eval(e: Expr): Value {
    switch (e.type) {
      case 'num': return e.value;
      case 'str': return e.value;
      case 'regex': return this.compileRegex(e.source).test(this.fields[0]) ? 1 : 0;
      case 'group': return this.eval(e.expr);
      case 'var': return this.getVar(e.name);
      case 'field': return this.getField(Math.trunc(toNum(this.eval(e.index))));
      case 'index': {
        const arr = this.getArray(e.name);
        const key = this.subscript(e.indices);
        if (!arr.has(key)) arr.set(key, ''); // referencing creates the element
        return arr.get(key) ?? '';
      }
      case 'assign': return this.evalAssign(e.op, e.target, e.value);
      case 'update': return this.evalUpdate(e.op, e.prefix, e.target);
      case 'unary': {
        if (e.op === '!') return toBool(this.eval(e.expr)) ? 0 : 1;
        const n = toNum(this.eval(e.expr));
        return e.op === '-' ? -n : +n;
      }
      case 'concat': return e.parts.map((p) => this.valToStr(this.eval(p))).join('');
      case 'ternary': return toBool(this.eval(e.cond)) ? this.eval(e.then) : this.eval(e.else);
      case 'binary': return this.evalBinary(e.op, e.left, e.right);
      case 'in': {
        const arr = this.getArray(e.array);
        return arr.has(this.subscript(e.indices)) ? 1 : 0;
      }
      case 'builtin': return this.evalBuiltin(e.name, e.args);
      case 'call': return this.evalCall(e.name, e.args);
      case 'getline': return this.evalGetline(e);
    }
  }

  private subscript(indices: Expr[]): string {
    if (indices.length === 1) return this.valToStr(this.eval(indices[0]));
    const subsep = this.str('SUBSEP');
    return indices.map((i) => this.valToStr(this.eval(i))).join(subsep);
  }

  private evalBinary(op: string, leftE: Expr, rightE: Expr): Value {
    // Short-circuit logicals.
    if (op === '&&') return toBool(this.eval(leftE)) && toBool(this.eval(rightE)) ? 1 : 0;
    if (op === '||') return toBool(this.eval(leftE)) || toBool(this.eval(rightE)) ? 1 : 0;
    if (op === '~' || op === '!~') {
      const s = this.valToStr(this.eval(leftE));
      const re = rightE.type === 'regex' ? this.compileRegex(rightE.source) : this.compileRegex(this.valToStr(this.eval(rightE)));
      const m = re.test(s);
      return (op === '~' ? m : !m) ? 1 : 0;
    }
    const l = this.eval(leftE);
    const r = this.eval(rightE);
    switch (op) {
      case '+': return toNum(l) + toNum(r);
      case '-': return toNum(l) - toNum(r);
      case '*': return toNum(l) * toNum(r);
      case '/': { const d = toNum(r); if (d === 0) throw new Error('awk: division by zero'); return toNum(l) / d; }
      case '%': { const d = toNum(r); if (d === 0) throw new Error('awk: division by zero in %'); return remainder(toNum(l), d); }
      case '^': return Math.pow(toNum(l), toNum(r));
      default: return this.compare(op, l, r) ? 1 : 0;
    }
  }

  /** awk comparison: numeric if both operands are numbers/numeric-strings. */
  private compare(op: string, l: Value, r: Value): boolean {
    let cmp: number;
    if (looksNumeric(l) && looksNumeric(r)) {
      const a = toNum(l), b = toNum(r);
      cmp = a < b ? -1 : a > b ? 1 : 0;
    } else {
      const a = this.valToStr(l), b = this.valToStr(r);
      cmp = a < b ? -1 : a > b ? 1 : 0;
    }
    switch (op) {
      case '<': return cmp < 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '>=': return cmp >= 0;
      case '==': return cmp === 0;
      case '!=': return cmp !== 0;
      default: return false;
    }
  }

  private evalAssign(op: string, target: LValue, valueE: Expr): Value {
    let value: Value;
    if (op === '=') {
      value = this.eval(valueE);
    } else {
      const cur = toNum(this.readLValue(target));
      const rhs = toNum(this.eval(valueE));
      switch (op) {
        case '+=': value = cur + rhs; break;
        case '-=': value = cur - rhs; break;
        case '*=': value = cur * rhs; break;
        case '/=': if (rhs === 0) throw new Error('awk: division by zero in /='); value = cur / rhs; break;
        case '%=': if (rhs === 0) throw new Error('awk: division by zero in %='); value = remainder(cur, rhs); break;
        case '^=': value = Math.pow(cur, rhs); break;
        default: value = rhs;
      }
    }
    this.writeLValue(target, value);
    return value;
  }

  private evalUpdate(op: '++' | '--', prefix: boolean, target: LValue): Value {
    const old = toNum(this.readLValue(target));
    const next = op === '++' ? old + 1 : old - 1;
    this.writeLValue(target, next);
    return prefix ? next : old;
  }

  private readLValue(lv: LValue): Value {
    switch (lv.type) {
      case 'var': return this.getVar(lv.name);
      case 'field': return this.getField(Math.trunc(toNum(this.eval(lv.index))));
      case 'index': {
        const arr = this.getArray(lv.name);
        const key = this.subscript(lv.indices);
        return arr.get(key) ?? '';
      }
    }
  }

  private writeLValue(lv: LValue, value: Value): void {
    switch (lv.type) {
      case 'var': this.setVar(lv.name, value); return;
      case 'field': this.setField(Math.trunc(toNum(this.eval(lv.index))), value); return;
      case 'index': {
        const arr = this.getArray(lv.name);
        arr.set(this.subscript(lv.indices), value);
        return;
      }
    }
  }

  // ── builtins ──────────────────────────────────────────────────────────────

  private evalBuiltin(name: string, args: Expr[]): Value {
    switch (name) {
      case 'length': {
        if (args.length === 0) return this.fields[0].length;
        const a = args[0];
        if (a.type === 'var') {
          const cell = this.scopeFor(a.name).get(a.name);
          if (isArray(cell)) return cell.size;
        }
        return this.valToStr(this.eval(a)).length;
      }
      case 'substr': {
        const s = this.valToStr(this.eval(args[0]));
        let m = Math.trunc(toNum(this.eval(args[1])));
        // awk substr is 1-based; positions < 1 count from before the string.
        let len = args.length >= 3 ? Math.trunc(toNum(this.eval(args[2]))) : Infinity;
        let start = m - 1;
        if (start < 0) { len += start; start = 0; }
        if (len < 0) len = 0;
        if (len === Infinity) return s.slice(start);
        return s.slice(start, start + len);
      }
      case 'index': {
        const s = this.valToStr(this.eval(args[0]));
        const t = this.valToStr(this.eval(args[1]));
        return s.indexOf(t) + 1;
      }
      case 'split': return this.doSplit(args);
      case 'sub': return this.doSub(args, false);
      case 'gsub': return this.doSub(args, true);
      case 'match': return this.doMatch(args);
      case 'sprintf': {
        const fmt = this.valToStr(this.eval(args[0]));
        return sprintf(fmt, args.slice(1).map((a) => this.eval(a)));
      }
      case 'sin': return Math.sin(toNum(this.eval(args[0])));
      case 'cos': return Math.cos(toNum(this.eval(args[0])));
      case 'atan2': return Math.atan2(toNum(this.eval(args[0])), toNum(this.eval(args[1])));
      case 'exp': return Math.exp(toNum(this.eval(args[0])));
      case 'log': return Math.log(toNum(this.eval(args[0])));
      case 'sqrt': return Math.sqrt(toNum(this.eval(args[0])));
      case 'int': return Math.trunc(toNum(this.eval(args[0])));
      case 'rand': return this.rng();
      case 'srand': {
        const prev = this.rngSeed;
        this.rngSeed = args.length > 0 ? Math.trunc(toNum(this.eval(args[0]))) : 0;
        this.rng = mulberry32(this.rngSeed);
        return prev;
      }
      case 'tolower': return this.valToStr(this.eval(args[0])).toLowerCase();
      case 'toupper': return this.valToStr(this.eval(args[0])).toUpperCase();
      case 'system': return 0; // sandboxed: no external commands
      case 'close': return 0;
      case 'fflush': return 0;
      default: throw new Error(`awk: unknown builtin ${name}`);
    }
  }

  private doSplit(args: Expr[]): Value {
    const s = this.valToStr(this.eval(args[0]));
    const arrExpr = args[1];
    if (arrExpr.type !== 'var') throw new Error('awk: split() needs an array');
    const arr = this.getArray(arrExpr.name);
    arr.clear();
    let parts: string[];
    let fs: string;
    if (args.length >= 3) {
      fs = args[2].type === 'regex' ? args[2].source : this.valToStr(this.eval(args[2]));
    } else {
      fs = this.str('FS');
    }
    if (fs === ' ') {
      const t = s.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
      parts = t === '' ? [] : t.split(/[ \t\n]+/);
    } else if (s === '') {
      parts = [];
    } else if (fs.length === 1 && !'\\^$.|?*+(){}['.includes(fs)) {
      parts = s.split(fs);
    } else if (fs === '') {
      parts = s.split('');
    } else {
      parts = s.split(this.compileRegex(fs));
    }
    parts.forEach((p, i) => arr.set(String(i + 1), p));
    return parts.length;
  }

  private doSub(args: Expr[], global: boolean): Value {
    const re = args[0].type === 'regex'
      ? this.compileRegex(args[0].source, global ? 'g' : '')
      : this.compileRegex(this.valToStr(this.eval(args[0])), global ? 'g' : '');
    const repl = this.valToStr(this.eval(args[1]));
    const target: LValue = (args.length >= 3 ? args[2] : { type: 'field', index: { type: 'num', value: 0 } }) as LValue;
    const original = this.valToStr(this.readLValue(target));
    let count = 0;
    const result = original.replace(re, (matched: string) => {
      // We expand only `&` (whole match) and `\&` in the replacement, not groups.
      count++;
      return expandReplacement(repl, matched);
    });
    if (count > 0) this.writeLValue(target, result);
    return count;
  }

  private doMatch(args: Expr[]): Value {
    const s = this.valToStr(this.eval(args[0]));
    const re = args[1].type === 'regex'
      ? this.compileRegex(args[1].source)
      : this.compileRegex(this.valToStr(this.eval(args[1])));
    const m = re.exec(s);
    if (m) {
      this.globals.set('RSTART', m.index + 1);
      this.globals.set('RLENGTH', m[0].length);
      return m.index + 1;
    }
    this.globals.set('RSTART', 0);
    this.globals.set('RLENGTH', -1);
    return 0;
  }

  // ── user functions ──────────────────────────────────────────────────────────

  private evalCall(name: string, args: Expr[]): Value {
    const fn = this.program.functions.get(name);
    if (!fn) throw new Error(`awk: calling undefined function ${name}`);
    const scope = new Map<string, Cell>();
    for (let i = 0; i < fn.params.length; i++) {
      const param = fn.params[i];
      const argExpr = args[i];
      if (argExpr === undefined) {
        // Extra params are uninitialized locals; default to "" (scalar) but may
        // become an array on first array use.
        scope.set(param, '');
      } else if (argExpr.type === 'var' && this.canBeArrayArg(argExpr.name)) {
        // Arrays (and as-yet-untyped bare names) are passed by reference: bind
        // the same Map so the callee can populate the caller's array.
        scope.set(param, this.getArray(argExpr.name));
      } else {
        scope.set(param, this.eval(argExpr));
      }
    }
    this.locals.push(scope);
    try {
      this.execStmts(fn.body);
      return '';
    } catch (sig) {
      if (sig instanceof ReturnSignal) return sig.value;
      throw sig;
    } finally {
      this.locals.pop();
    }
  }

  /**
   * Whether a bare-name argument should be passed by reference as an array.
   * True when it is already an array, or when it is wholly uninitialized — awk
   * passes uninitialized names by reference so a callee can populate them as an
   * array (the common `split`/fill idiom). An already-scalar name is passed by
   * value.
   */
  private canBeArrayArg(name: string): boolean {
    const cell = this.scopeFor(name).get(name);
    return isArray(cell) || cell === undefined;
  }

  // ── getline ──────────────────────────────────────────────────────────────────

  private fileReaders = new Map<string, { lines: string[]; pos: number }>();

  private evalGetline(e: Extract<Expr, { type: 'getline' }>): Value {
    if (e.source === 'main') {
      if (this.lineQueuePos >= this.lineQueue.length) return 0; // EOF
      const line = this.lineQueue[this.lineQueuePos++];
      this.globals.set('NR', this.num('NR') + 1);
      this.globals.set('FNR', this.num('FNR') + 1);
      if (e.into) this.writeLValue(e.into, line);
      else this.setRecord(line);
      return 1;
    }
    if (e.source === 'file') {
      const path = this.valToStr(this.eval(e.arg!));
      let reader = this.fileReaders.get(path);
      if (!reader) {
        if (!this.io.readFile) return -1;
        const content = this.io.readFile(path);
        if (content === undefined) return -1; // error
        reader = { lines: splitRecords(content, this.str('RS')), pos: 0 };
        this.fileReaders.set(path, reader);
      }
      if (reader.pos >= reader.lines.length) return 0;
      const line = reader.lines[reader.pos++];
      this.globals.set('NR', this.num('NR') + 1);
      if (e.into) this.writeLValue(e.into, line);
      else { this.setRecord(line); }
      return 1;
    }
    // cmd | getline
    const cmd = this.valToStr(this.eval(e.arg!));
    let reader = this.fileReaders.get('cmd:' + cmd);
    if (!reader) {
      if (!this.io.runCommand) return -1;
      const content = this.io.runCommand(cmd);
      if (content === undefined) return -1;
      reader = { lines: splitRecords(content, this.str('RS')), pos: 0 };
      this.fileReaders.set('cmd:' + cmd, reader);
    }
    if (reader.pos >= reader.lines.length) return 0;
    const line = reader.lines[reader.pos++];
    this.globals.set('NR', this.num('NR') + 1);
    if (e.into) this.writeLValue(e.into, line);
    else this.setRecord(line);
    return 1;
  }

  // ── regex compilation ──────────────────────────────────────────────────────

  private regexCache = new Map<string, RegExp>();
  private compileRegex(source: string, extraFlags = ''): RegExp {
    const key = extraFlags + '\0' + source;
    let re = this.regexCache.get(key);
    if (!re) {
      re = new RegExp(translateEre(source), extraFlags);
      this.regexCache.set(key, re);
    }
    // Reset lastIndex for cached global regexes so .test/.exec are stateless here.
    re.lastIndex = 0;
    return re;
  }
}

// ── module-level helpers ───────────────────────────────────────────────────────

/** awk `%` is fmod (truncated toward zero), not JS `%` for negatives? JS `%`
 * already matches C fmod for the integer cases awk uses. */
function remainder(a: number, b: number): number { return a % b; }

/** Seeded PRNG: mulberry32. Deterministic given a seed — never Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split input text into records on the record separator RS.
 *  - RS == "\n" (default): split on newlines, dropping a single trailing one.
 *  - RS == "" : paragraph mode — records separated by blank lines.
 *  - single char: literal separator.
 *  - multi char: ERE separator. */
export function splitRecords(text: string, rs: string): string[] {
  if (text === '') return [];
  if (rs === '\n') {
    const t = text.endsWith('\n') ? text.slice(0, -1) : text;
    return t === '' ? [''] : t.split('\n');
  }
  if (rs === '') {
    // Paragraph mode: strip leading newlines, split on 2+ newlines.
    const t = text.replace(/^\n+/, '').replace(/\n+$/, '');
    return t === '' ? [] : t.split(/\n{2,}/);
  }
  if (rs.length === 1) {
    const t = text.endsWith(rs) ? text.slice(0, -1) : text;
    return t.split(rs);
  }
  const re = new RegExp(translateEre(rs));
  const t = text.replace(new RegExp(translateEre(rs) + '$'), '');
  return t.split(re);
}

/** Expand a sub/gsub replacement string: `&` → matched text, `\&` → literal &. */
function expandReplacement(repl: string, matched: string): string {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const c = repl[i];
    if (c === '\\') {
      const n = repl[i + 1];
      if (n === '&') { out += '&'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      out += '\\';
      continue;
    }
    if (c === '&') { out += matched; continue; }
    out += c;
  }
  return out;
}

/** Process C-style escapes in a `-v`/command-line assignment value. */
function processEscapes(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      default: out += '\\' + (n ?? ''); break;
    }
  }
  return out;
}

/** Escape a literal char for use in a RegExp. */
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Translate an awk ERE source to a JS RegExp source. awk EREs are largely a
 * subset of JS regex; we additionally expand POSIX bracket classes
 * (`[[:alpha:]]` etc.) which JS does not support natively.
 */
export function translateEre(src: string): string {
  // Expand POSIX character classes inside bracket expressions.
  const POSIX: Record<string, string> = {
    alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
    space: ' \\t\\r\\n\\v\\f', blank: ' \\t', punct: '!-/:-@\\[-`{-~',
    xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
  };
  return src.replace(/\[:([a-z]+):\]/g, (m, cls: string) => POSIX[cls] ?? m);
}
