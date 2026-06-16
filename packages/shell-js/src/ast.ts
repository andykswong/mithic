/**
 * Shell AST node definitions.
 *
 * A {@link Program} is a list of {@link Statement}s. The minimal viable grammar
 * covers pipelines of simple commands with redirects and assignment prefixes,
 * plus `if`/`while` compound commands. Lists are joined by `;`, `&&`, `||`.
 *
 * To keep node access ergonomic (and to compile the spec's structural test
 * accesses without casts), every statement shares one {@link Statement}
 * interface discriminated by `type`; members not relevant to a given `type`
 * are simply absent at runtime but optionally typed here.
 */

export type RedirectOp = '>' | '>>' | '<';

export interface Redirect {
  op: RedirectOp;
  /** Optional source fd (e.g. `2>` → fd 2). Defaults per op. */
  fd?: number;
  /** Raw target word (subject to expansion at execution time). */
  target: string;
}

export interface Assignment {
  name: string;
  /** Raw assignment value (subject to expansion at execution time). */
  value: string;
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

export type StatementType = 'Pipeline' | 'If' | 'While' | 'And' | 'Or';

export interface Statement {
  type: StatementType;
  /** Pipeline: pipe stages, left to right. */
  stages: SimpleCommand[];
  /** Pipeline: terminated with `&` (background). */
  background?: boolean;
  /** If/While: condition list. */
  condition?: Statement[];
  /** If: then-branch. */
  then?: Statement[];
  /** If: else-branch. */
  else?: Statement[];
  /** While: loop body. */
  body?: Statement[];
  /** While: `until` inverts the condition. */
  until?: boolean;
  /** And/Or: left operand. */
  left?: Statement;
  /** And/Or: right operand. */
  right?: Statement;
}

export interface Program {
  type: 'Program';
  body: Statement[];
}
