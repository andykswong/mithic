/**
 * Shell AST node definitions.
 *
 * A {@link Program} is a list of {@link Statement}s. The grammar covers
 * pipelines of simple commands with redirects and assignment prefixes, plus
 * compound commands: `if`/`while`/`until`/`for`/`case`, function definitions,
 * and subshell/group commands. Lists are joined by `;`, `&&`, `||`.
 *
 * Every statement shares one {@link Statement} interface discriminated by
 * `type`; members not relevant to a given `type` are absent at runtime but
 * optionally typed here.
 */

export type RedirectOp =
  | '>'      // truncate stdout (or fd)
  | '>|'     // truncate stdout, forcing past noclobber (set -C)
  | '>>'     // append stdout (or fd)
  | '<'      // stdin from file
  | '<>'     // open fd for reading AND writing
  | '<<'     // here-doc
  | '<<<'    // here-string
  | '>&'     // duplicate / merge fd (e.g. 2>&1, >&2)
  | '&>'     // redirect both stdout+stderr (truncate)
  | '&>>';   // redirect both stdout+stderr (append)

export interface Redirect {
  op: RedirectOp;
  /** Optional source fd (e.g. `2>` → fd 2). Defaults per op. */
  fd?: number;
  /** Raw target word (subject to expansion at execution time). For `>&` the
   *  target is the destination fd as a string (e.g. `"1"`) or `"-"` to close. */
  target: string;
  /** For here-docs/here-strings: the literal body (here-doc) or word (here-string). */
  hereDoc?: string;
  /** For here-docs: whether the delimiter was quoted (suppresses expansion). */
  hereDocQuoted?: boolean;
}

export interface Assignment {
  name: string;
  /** Raw assignment value (subject to expansion at execution time). */
  value: string;
  /**
   * Array-literal element words (raw), present for `name=(a b c)`. When set, the
   * assignment defines an indexed array rather than a scalar (`value` is unused).
   */
  array?: string[];
  /** Element index word (raw) for `name[index]=value`. Subject to expansion. */
  index?: string;
  /** `+=` append form (`name+=v`, `name+=(d)`, `name[i]+=v`). */
  append?: boolean;
}

export interface SimpleCommand {
  type: 'SimpleCommand';
  /** Command name (raw word, pre-expansion). Empty when only assignments. */
  name: string;
  /** Argument words (raw, pre-expansion). */
  args: string[];
  redirects: Redirect[];
  assignments: Assignment[];
}

export type StatementType =
  | 'Pipeline'
  | 'If'
  | 'While'
  | 'For'
  | 'Select'
  | 'Case'
  | 'And'
  | 'Or'
  | 'Function'
  | 'Subshell'
  | 'Group'
  | 'Coproc'     // coproc [NAME] command  /  coproc NAME { ...; }
  | 'Arithmetic'
  | 'Cond';      // [[ ... ]]

/** One `case` clause: patterns (|-separated) → body. */
export interface CaseClause {
  patterns: string[];
  body: Statement[];
}

export interface Statement {
  type: StatementType;
  /** Pipeline: pipe stages, left to right (all-simple fast path). */
  stages?: SimpleCommand[];
  /**
   * Pipeline: general stages as full command nodes, present when ANY stage is a
   * compound command (subshell/group/if/while/for/...). When set, the executor
   * runs stages in-process (capturing each stage's stdout for the next's stdin)
   * rather than via the kernel spawn fast path. Mirrors `stages` for the
   * all-simple case to keep one code path.
   */
  stageNodes?: Statement[];
  /**
   * Pipeline: per-INTER-stage `|&` flags. `pipeStderr[i] === true` means the
   * pipe BEFORE stage i+1 also carries the previous stage's stderr.
   */
  pipeStderr?: boolean[];
  /** Pipeline: terminated with `&` (background). */
  background?: boolean;
  /** Pipeline: negated with leading `!`. */
  negate?: boolean;
  /** Redirects attached to a compound command (e.g. `while ...; done > f`). */
  redirects?: Redirect[];
  /** If/While: condition list. */
  condition?: Statement[];
  /** If: then-branch. */
  then?: Statement[];
  /** If: else-branch. */
  else?: Statement[];
  /** While/For: loop body. */
  body?: Statement[];
  /** While: `until` inverts the condition. */
  until?: boolean;
  /** And/Or: left operand. */
  left?: Statement;
  /** And/Or: right operand. */
  right?: Statement;
  /** For: loop variable name. */
  varName?: string;
  /** For: word list to iterate (raw, pre-expansion). Absent ⇒ `"$@"`. */
  words?: string[];
  /** For: true when this is an arithmetic C-style for (uses arith fields). */
  arithFor?: boolean;
  /** C-style for: init / cond / incr expression text (raw). */
  arithInit?: string;
  arithCond?: string;
  arithIncr?: string;
  /** Case: the word being matched (raw). */
  caseWord?: string;
  /** Case: clauses. */
  clauses?: CaseClause[];
  /** Function: name. */
  funcName?: string;
  /** Function: body (a group/compound). */
  funcBody?: Statement[];
  /** Arithmetic command `(( expr ))` / Cond `[[ ... ]]`: raw expression text. */
  expr?: string;
  /** Cond `[[ ... ]]`: tokenized words. */
  condWords?: string[];
  /**
   * Coproc: the coproc array NAME (default `COPROC`). The shell exposes
   * `${NAME[0]}` (read fd), `${NAME[1]}` (write fd) and `NAME_PID`.
   */
  coprocName?: string;
  /** Coproc: the command run as the coprocess (a single Statement). */
  coprocBody?: Statement;
}

export interface Program {
  type: 'Program';
  body: Statement[];
}
