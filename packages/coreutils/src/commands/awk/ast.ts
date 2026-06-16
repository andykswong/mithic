/**
 * Abstract syntax tree for the POSIX awk language.
 *
 * The parser ({@link import('./parser.ts')}) produces a {@link Program} from a
 * token stream; the interpreter ({@link import('./interp.ts')}) walks it. Nodes
 * are plain discriminated unions tagged by `type` — no classes, so the tree is
 * trivially serializable and erasable-syntax friendly.
 */

// ── expressions ───────────────────────────────────────────────────────────────

/** A numeric literal: `42`, `3.14`, `1e3`. The lexer stores the parsed value. */
export interface NumberLit { type: 'num'; value: number; }
/** A string literal: `"abc"` with escapes already decoded by the lexer. */
export interface StringLit { type: 'str'; value: string; }
/** A regex literal used as a value/condition: `/re/` → matches against `$0`. */
export interface RegexLit { type: 'regex'; source: string; }
/** A bare variable reference: `x`, `NR`, `FS`. */
export interface VarRef { type: 'var'; name: string; }
/** A field reference: `$0`, `$1`, `$(NF-1)`. `index` is an expression. */
export interface FieldRef { type: 'field'; index: Expr; }
/** An array element: `a[i]` or multidim `a[i,j]` (indices joined by SUBSEP). */
export interface IndexRef { type: 'index'; name: string; indices: Expr[]; }
/** Grouping `( expr )` — kept so the parser can disambiguate `(k in a)`. */
export interface Grouping { type: 'group'; expr: Expr; }

/** Assignable l-values: bare var, field, or array element. */
export type LValue = VarRef | FieldRef | IndexRef;

/** Binary arithmetic/comparison/logical/match operator application. */
export interface Binary { type: 'binary'; op: BinaryOp; left: Expr; right: Expr; }
export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '<' | '<=' | '==' | '!=' | '>=' | '>'
  | '&&' | '||'
  | '~' | '!~';

/** String concatenation by juxtaposition: `a b` → concat. */
export interface Concat { type: 'concat'; parts: Expr[]; }
/** Unary `-`, `+`, `!`. */
export interface Unary { type: 'unary'; op: '-' | '+' | '!'; expr: Expr; }
/** Pre/post increment/decrement on an l-value. */
export interface Update { type: 'update'; op: '++' | '--'; prefix: boolean; target: LValue; }
/** Assignment, possibly compound (`+=` etc.). */
export interface Assign { type: 'assign'; op: AssignOp; target: LValue; value: Expr; }
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '^=';
/** Ternary `cond ? a : b`. */
export interface Ternary { type: 'ternary'; cond: Expr; then: Expr; else: Expr; }
/** Membership test `(key) in arrayName` (key may be a multidim subscript list). */
export interface InExpr { type: 'in'; indices: Expr[]; array: string; }
/** Builtin function call: `length(x)`, `substr(...)`, etc. */
export interface BuiltinCall { type: 'builtin'; name: string; args: Expr[]; }
/** User-defined function call: `f(a, b)`. */
export interface CallExpr { type: 'call'; name: string; args: Expr[]; }
/**
 * `getline` in its supported forms. `into` is the l-value to assign (var/field/
 * array element) or undefined to assign `$0`. `source` distinguishes the form:
 *   - 'main'  : plain `getline` / `getline var` from the current input.
 *   - 'file'  : `getline [var] < expr` — read from a file named by `arg`.
 *   - 'cmd'   : `expr | getline [var]` — read from a command's output (`arg`).
 */
export interface GetlineExpr {
  type: 'getline';
  source: 'main' | 'file' | 'cmd';
  into?: LValue;
  arg?: Expr;
}

export type Expr =
  | NumberLit | StringLit | RegexLit
  | VarRef | FieldRef | IndexRef | Grouping
  | Binary | Concat | Unary | Update | Assign | Ternary
  | InExpr | BuiltinCall | CallExpr | GetlineExpr;

// ── statements ─────────────────────────────────────────────────────────────────

export interface ExprStmt { type: 'expr'; expr: Expr; }
/** `print` (or implicit) with an output redirect. */
export interface PrintStmt {
  type: 'print';
  args: Expr[];
  redirect?: Redirect;
}
/** `printf fmt, args...` with optional redirect. */
export interface PrintfStmt {
  type: 'printf';
  args: Expr[];
  redirect?: Redirect;
}
/** Output redirection target for print/printf. */
export interface Redirect { mode: '>' | '>>' | '|'; target: Expr; }

export interface IfStmt { type: 'if'; cond: Expr; then: Stmt; else?: Stmt; }
export interface WhileStmt { type: 'while'; cond: Expr; body: Stmt; }
export interface DoWhileStmt { type: 'dowhile'; body: Stmt; cond: Expr; }
export interface ForStmt {
  type: 'for';
  init?: Stmt;
  cond?: Expr;
  update?: Stmt;
  body: Stmt;
}
/** `for (k in array) body`. */
export interface ForInStmt { type: 'forin'; var: string; array: string; body: Stmt; }
export interface BlockStmt { type: 'block'; body: Stmt[]; }
export interface NextStmt { type: 'next'; }
export interface NextFileStmt { type: 'nextfile'; }
export interface ExitStmt { type: 'exit'; code?: Expr; }
export interface ReturnStmt { type: 'return'; value?: Expr; }
export interface BreakStmt { type: 'break'; }
export interface ContinueStmt { type: 'continue'; }
/** `delete a[k]` or `delete a` (clear whole array). */
export interface DeleteStmt { type: 'delete'; name: string; indices?: Expr[]; }
/** An empty statement (lone `;`). */
export interface EmptyStmt { type: 'empty'; }

export type Stmt =
  | ExprStmt | PrintStmt | PrintfStmt
  | IfStmt | WhileStmt | DoWhileStmt | ForStmt | ForInStmt | BlockStmt
  | NextStmt | NextFileStmt | ExitStmt | ReturnStmt | BreakStmt | ContinueStmt
  | DeleteStmt | EmptyStmt;

// ── rules & program ──────────────────────────────────────────────────────────

/**
 * A pattern guarding a rule. `'begin'`/`'end'` are the special blocks; `'always'`
 * is an action-only rule (runs for every record); `'expr'` is an expression
 * pattern; `'range'` is `start, end`.
 */
export type Pattern =
  | { type: 'begin' }
  | { type: 'end' }
  | { type: 'always' }
  | { type: 'expr'; expr: Expr }
  | { type: 'range'; start: Expr; end: Expr };

/** A `pattern { action }` rule. A missing action means implicit `print $0`. */
export interface Rule { pattern: Pattern; action?: Stmt[]; }

/** A user function definition. */
export interface FuncDef { name: string; params: string[]; body: Stmt[]; }

/** A complete awk program: ordered rules plus a function table. */
export interface Program { rules: Rule[]; functions: Map<string, FuncDef>; }
