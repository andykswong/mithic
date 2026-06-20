# @mithic/jq

A pure-TypeScript [jq](https://jqlang.github.io/jq/) JSON processor that runs as
a regular sandboxed Mithic process. It is a from-scratch reimplementation of the
jq filter language — lexer, parser, tree-walking interpreter, and builtins — with
no native binary and no WebAssembly. As a guest it reads JSON from stdin, applies
a filter program, and writes results to stdout; as a library it exposes the
engine for embedding jq directly in JavaScript.

This package replaces the previous WASM-based jq command.

## Pieces

The language engine is a four-stage pipeline (`@mithic/jq/engine`):

- `lex` (`lexer.ts`) — tokenizes a program into a flat `Token[]`. Handles
  numbers, strings with JSON escapes and `\(…)` interpolation, `@format`
  strings, `$var`, the `.`-prefixed forms (`.foo`, `.[`, `..`), keywords, and
  greedy multi-char operators (`//`, `?//`, `|=`, `//=`, comparisons, …).
- `parse` (`parser.ts`) — recursive-descent over the tokens, producing the
  tagged-union `Node` AST (`ast.ts`). Precedence (low→high): pipe `|`, comma `,`,
  `//` alternative, assignment operators, `or`, `and`, comparison, additive,
  multiplicative, unary `-`, then postfix suffixes (`.foo`, `[…]`, `?`).
  Assignments (`=`, `|=`, `+=`, …) are desugared into interpreter-handled calls.
- `evalNode` (`interp.ts`) — a generator-based evaluator: every filter is a
  `1 → many` mapping, so streaming and backtracking (`,`, `.[]`, `//`, `reduce`,
  filter-valued args) fall out of `yield*` over nested generators. The lexical
  scope chain (`Env`) is immutable, holding `$variables`, user `def` functions,
  and filter-valued (closure) parameters. `error`, `label`/`break`, and `limit`
  are implemented via thrown control signals.
- `builtins.ts` — the builtin functions, split into **simple** builtins (data
  driven, keyed by `name/arity`, args materialized as a cartesian product) and
  **higher-order** builtins (`map`, `select`, `reduce`-likes, `recurse`,
  `limit`, regex `sub`/`gsub`, path builtins, …) that re-enter the evaluator with
  the raw arg nodes. `values.ts` holds jq's type names, total order, deep
  equality, and the canonical serializer used by `tojson`/`@json`/`-S`.

Around the engine:

- `cli.ts` — `parseJqArgs` (argv → `JqOptions`), `parseInputs` / `parseJsonStream`
  (the whitespace-separated JSON input stream), and `formatOutput` (renders one
  output value per the output flags).
- `jq.ts` — the guest entry module (built to `dist/jq.js`): reads stdin, runs the
  filter over each input, and writes formatted results.
- `resolver.ts` — `resolveJq` / `createJqResolver`, a `resolveCommand(name, cwd,
  env)` factory that maps the name `"jq"` to the built guest module URL for
  `new Kernel({ resolveCommand })`.

## Quick start

### As a Mithic command

```ts
import { Kernel } from '@mithic/kernel';
import { resolveJq } from '@mithic/jq';

const kernel = new Kernel({ runtime, vfs, resolveCommand: resolveJq });
// A guest can now spawn `jq` by name; compose with other resolvers as needed:
const resolveCommand = (name, cwd, env) =>
  resolveJq(name, cwd, env) ?? createCoreutilsResolver()(name, cwd, env);
```

### As an embedded engine

```ts
import { compile, run } from '@mithic/jq';

run('.users | map(.name)', { users: [{ name: 'a' }, { name: 'b' }] });
// → [['a', 'b']]

// Compile once, apply to many inputs:
const f = compile('.value * 2');
[...f.run({ value: 21 })]; // → [42]
```

`run(program, input, options)` returns all outputs as an array; `compile`
returns a `CompiledFilter` whose `run(input, options)` is a generator. Both
accept `{ env, args }` — `args` are bound as `$name` (from `--arg`/`--argjson`)
and exposed via `$ARGS.named`; `env` backs the `env` builtin and `$ENV`.

## Command-line flags

`jq [FLAGS] FILTER` reads its JSON input from stdin (argv after the filter is
accepted but file operands are not read in the pipe).

| Flag | Meaning |
|---|---|
| `-r` / `--raw-output` | emit raw strings (no JSON quoting) |
| `-j` / `--join-output` | `-r` with no separator between outputs |
| `-c` / `--compact-output` | single-line JSON |
| `-n` / `--null-input` | run once with `null` input (don't read stdin) |
| `-s` / `--slurp` | read the whole input stream into one array |
| `-R` / `--raw-input` | each input line is a raw string (with `-s`, the whole text) |
| `-e` / `--exit-status` | exit non-zero when the last output is `false`/`null`/absent |
| `-a` / `--ascii-output` | escape non-ASCII as `\uXXXX` |
| `-S` / `--sort-keys` | sort object keys in output |
| `--tab` | indent with tabs |
| `--indent N` | indent with N spaces (default 2) |
| `--arg NAME VALUE` | bind `$NAME` to the string VALUE |
| `--argjson NAME JSON` | bind `$NAME` to a parsed JSON value |

Short flags cluster (e.g. `-rc`); `--` ends flag parsing; unknown flags are
ignored. Exit codes: `0` success, `3` compile (syntax) error, `4` `-e` with no
output, `5` runtime error, plus any code requested by `halt_error`.

## Supported filter features

The engine covers the bulk of the jq language:

- **Path & iteration:** identity `.`, field `.foo` / `."str"`, index `.[e]`,
  slice `.[a:b]`, iterate `.[]`, recursive descent `..`, optional `?`, and
  pipes `|`.
- **Construction:** array `[…]` and object `{…}` literals, including the `{$x}` /
  `{foo}` / `{(expr): …}` / `{"k": …}` key forms and string interpolation
  `"\(.x)"`.
- **Operators:** `+ - * / %` with jq's per-type semantics (array concat/subtract,
  object merge, string repeat/split), comparisons, `and` / `or` / `not`, the
  `//` alternative operator, and unary minus.
- **Assignment / update:** `=`, `|=`, `+=`, `-=`, `*=`, `/=`, `%=`, `//=` over
  path expressions, plus `setpath` / `getpath` / `delpaths` / `paths` / `del`.
- **Control flow:** `if/elif/else/end`, `try/catch`, `reduce … as $p (init; upd)`,
  `foreach … as $p (init; upd; extract)`, `label $out | … break $out`, and
  destructuring binding `EXP as PATTERN | …` (array / object / `?//` alternative
  patterns).
- **Definitions:** user functions `def f(args): …;` with `$value` and
  filter-valued (closure) parameters and recursion.
- **Builtins** (selection): `length`, `keys`/`keys_unsorted`, `has`/`in`,
  `contains`/`inside`, `type`, `add`, `map`/`map_values`/`select`,
  `to_entries`/`from_entries`/`with_entries`, `sort`/`sort_by`/`group_by`/
  `unique`/`unique_by`, `min`/`max`/`min_by`/`max_by`, `range`, `first`/`last`/
  `nth`/`limit`, `recurse`/`walk`/`until`/`while`/`repeat`, `flatten`/`reverse`/
  `join`/`split`, `paths`/`leaf_paths`/`getpath`/`setpath`/`del`,
  type predicates (`objects`, `arrays`, `numbers`, `strings`, `nulls`,
  `iterables`, `scalars`, `values`), string functions (`ascii_upcase`/
  `ascii_downcase`, `ltrimstr`/`rtrimstr`, `startswith`/`endswith`, `explode`/
  `implode`, `tostring`/`tonumber`/`tojson`/`fromjson`), math (`floor`/`ceil`/
  `round`/`sqrt`/`pow`/`log`/`exp`/…), regex (`test`, `match`, `capture`,
  `scan`-style `splits`, `sub`/`gsub`), and `env`/`now`/`error`/`halt`/
  `halt_error`.
- **`@format` strings:** `@text`, `@json`, `@base64`/`@base64d`, `@uri`, `@csv`,
  `@tsv`, `@html`, `@sh` — usable as bare filters, as `@fmt "…"`, and inside
  string interpolation.

> Regex uses JavaScript's `RegExp` rather than Oniguruma; common flags
> (`g`, `i`, `s`, `m`, `p`) map closely, while Oniguruma-only features (e.g. the
> extended `x` flag) are best-effort or ignored. Modules (`import`/`include`),
> SQL-style builtins, and `$__loc__` line tracking beyond a fixed stub are not
> implemented.

## Testing

```sh
npm run build && npm test    # build first — tests import from dist/
```
