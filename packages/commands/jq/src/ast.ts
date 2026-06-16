/**
 * jq abstract syntax tree. Every jq program is a single {@link Node} (a filter)
 * that the interpreter evaluates against an input value, producing a stream of
 * output values. Nodes are plain tagged objects so the interpreter can switch
 * on `kind` without a visitor framework.
 */

export type Node =
  | { kind: 'identity' }
  | { kind: 'recurseDefault' } // `..`
  | { kind: 'field'; name: string; optional: boolean }
  | { kind: 'index'; target: Node; index: Node; optional: boolean } // .[e] / e[e]
  | { kind: 'slice'; target: Node; from: Node | null; to: Node | null; optional: boolean }
  | { kind: 'iterate'; target: Node; optional: boolean } // .[]
  | { kind: 'pipe'; left: Node; right: Node }
  | { kind: 'comma'; left: Node; right: Node }
  | { kind: 'literal'; value: unknown }
  | { kind: 'strinterp'; parts: Array<{ type: 'lit'; value: string } | { type: 'interp'; node: Node }>; format: string | null }
  | { kind: 'format'; name: string } // bare @base64 used as a filter
  | { kind: 'array'; body: Node | null }
  | { kind: 'object'; entries: ObjectEntry[] }
  | { kind: 'binop'; op: BinOp; left: Node; right: Node }
  | { kind: 'and'; left: Node; right: Node }
  | { kind: 'or'; left: Node; right: Node }
  | { kind: 'alternative'; left: Node; right: Node } // //
  | { kind: 'negate'; operand: Node } // unary minus
  | { kind: 'if'; cond: Node; then: Node; elifs: Array<{ cond: Node; then: Node }>; else: Node | null }
  | { kind: 'try'; body: Node; catch: Node | null }
  | { kind: 'reduce'; source: Node; pattern: Pattern; init: Node; update: Node }
  | { kind: 'foreach'; source: Node; pattern: Pattern; init: Node; update: Node; extract: Node | null }
  | { kind: 'bind'; source: Node; patterns: Pattern[]; body: Node } // EXP as $p1 ?// $p2 | body
  | { kind: 'funcdef'; name: string; params: string[]; body: Node; rest: Node }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'var'; name: string }
  | { kind: 'loc' } // $__loc__
  | { kind: 'label'; name: string; body: Node }
  | { kind: 'break'; name: string }
  | { kind: 'optional'; body: Node }; // body?

export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface ObjectEntry {
  /** Key expression: a node producing the key (string), or a fixed string. */
  key: Node;
  /** Value expression; null means shorthand `{$x}` / `{foo}` (value = .foo). */
  value: Node | null;
}

/** Destructuring patterns for `as`/`reduce`/`foreach` bindings. */
export type Pattern =
  | { kind: 'var'; name: string }
  | { kind: 'array'; elements: Pattern[] }
  | { kind: 'object'; entries: Array<{ keyVar?: string; key?: Node; value: Pattern }> };
