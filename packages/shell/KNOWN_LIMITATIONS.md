# `@mithic/shell` — Known Limitations & bash-parity registry

This document tracks where the Mithic shell (`@mithic/shell`) intentionally or
not-yet diverges from real bash, prioritized for AI-agent use cases (agents running
shell scripts in the sandbox). It is the companion to the bash-comparison
golden-fixture harness in `src/comparison/` (see "Comparison harness" below).

Status legend: **done** = closed (covered by tests / fixtures); **pending** = not
yet implemented; **divergence** = a deliberate, documented difference from bash.

---

## Comparison harness (`src/comparison/`)

`compareWithBash(name, src)` records real `/bin/bash` output (`RECORD_FIXTURES=1`)
into `src/comparison/fixtures/*.json`, then in normal/CI mode replays mithic's
`Executor` (mock kernel) output against the golden fixture. It compares **stdout
only** — the mock kernel always exits children 0, so exit-code comparison is opt-in.

Scope: this is shell-**LANGUAGE** comparison (builtins, parameter expansion,
arithmetic, control flow, POSIX mode) — **not** spawned-command comparison.
Commands like `ls`/`grep`/coreutils run as *spawned guests* over the real kernel,
not in this mock-kernel harness; the mock's `spawn`/`wait` are stubs. **Every
comparison case must be builtin/expansion-only.** A COMMAND-level (coreutils)
comparison harness — driving the real kernel + guest spawns — is a separate future
effort, not covered here.

### Fixture provenance — bash version

The committed fixtures were recorded against **macOS `/bin/bash` 3.2.57** (the local
dev machine). bash 3.2 LACKS bash-4+ features (case modification `${s^^}`/`${s,,}`,
`mapfile`, `read -a`, associative arrays, `${var@Q}`). Therefore:

- Fixtures **SHOULD be (re)recorded on the CI bash version** (newer, typically
  bash 5.x on Linux) via `RECORD_FIXTURES=1` to avoid platform drift. Every case in
  the `CASES` list is chosen to produce **identical** output on bash 3.2 AND bash
  5.x (verified locally), so re-recording on 3.2 is a no-op — the local dev host
  (bash 3.2) does NOT churn these fixtures, and **CI (Linux bash 5.x) owns
  re-recording the full suite**.
- **bash-4+ cases** (`case-upper` / `${s^^}`, `${var@Q}` quoting, single-line
  `$LINENO`) are hand-recorded from known bash-5 output, because recording them on
  bash 3.2 would capture a `bad substitution` error (or, for `$LINENO`, the 3.2
  value `0` rather than the modern `1`) as golden. `compareWithBash4(...)` refuses
  to record on the default host unless `RECORD_BASH4=1` is also set (signalling a
  bash-4+ host). mithic matches the bash-5 golden for all of these.

#### `printf %q` quoting-style divergence (not in the suite)

`printf %q` produces a re-inputtable quoting, but the *style* differs from bash for
words containing shell-special characters: mithic emits the single-quote form
(`'a b'`, via the shared `shellQuote` in `quote.ts`), whereas bash emits the
backslash-escaped form (`a\ b`). Both round-trip to the same shell word, but the
bytes differ, so only the already-safe case (`printf %q hello` → `hello`, identical
everywhere) is in the comparison suite. The special-char `printf %q` case is a
deliberate, documented style divergence, not a regression.

---

## Deliberate divergences (mithic ≠ bash, on purpose)

| Behavior | bash | mithic | AI-agent note | Status |
|----------|------|--------|---------------|--------|
| **Brace expansion in POSIX mode** | bash KEEPS brace expansion on in posix mode (`echo {a,b,c}` → `a b c` under `--posix`/`set -o posix`/`POSIXLY_CORRECT=1`) | mithic SUPPRESSES it (`{a,b,c}` literal) — matches a true POSIX `sh` (dash), stricter than bash | Agents enabling `set -o posix` for strict scripts get dash-style brace handling, not bash-style. Fixture `brace-suppressed-posix.json` holds the bash golden; the case is `.skip`-ped in `shell-behavior.comparison.test.ts`. | **divergence** |

---

## Closed in the core-engine correctness wave (`done`)

These shipped in this branch (`feat/core-engine-correctness`) and are covered by
tests; they are the parity items this wave closed.

| Item | AI-agent use case | Status |
|------|-------------------|--------|
| `#!/usr/bin/env <interp>` shebang arg honored | Exec-from-VFS scripts with the portable `env` shebang dispatch correctly (was dropped → misdispatch as interpreter `/usr/bin/env`) | **done** |
| CRLF shebang lines tolerated | Scripts authored on Windows (CRLF) parse the interpreter without a trailing `\r` leak | **done** |
| POSIX special-builtin fatality (POSIX 2.8.1) | A fatal error in a special builtin aborts a non-interactive shell in posix mode (no silent continue), via `PosixSpecialBuiltinError`. Covers BOTH (a) a bad `set` option (`set -o bogus`), (b) the canonical **redirection error** on a special builtin (`: > existing` under `set -C`, `export X=1 > /bad`) — the `execSimple`/`withRedirects` redirect-error path throws `PosixSpecialBuiltinError` when the failing command is in `POSIX_SPECIAL_BUILTINS` and posix mode is on — AND (c) the **variable-assignment error** path: reassigning a `readonly` variable in posix mode throws `PosixSpecialBuiltinError` from `applyAssignment` so the script aborts. A redirect error on a NON-special builtin (`echo`) stays non-fatal. | **done** |
| Process substitution `<(…)`/`>(…)` rejected in POSIX mode | Agents in strict posix mode get a clear rejection instead of a bash-only extension | **done** |
| `read -r` (raw — no backslash mangling) | `read -r line` preserves backslashes; the prior silent `-r` ignore was a correctness trap | **done** |
| `read -a` / `read -d` / `read -n` / `read -N` (incl. clustered `-ra`/`-rn3`) | Parse a line into an array; NUL/custom delimiters (`find -print0`); `-n` (≤N, stop at delim) and `-N` (exactly N, ignore delim); short flags cluster like bash (`read -ra arr`, `read -rn3 x`) | **done** |
| `mapfile` / `readarray` | Slurp multi-line output into an array (`mapfile -t lines`) | **done** |
| `${var@Q}` / `printf %q` | Inject-safe quoting when an agent builds shell commands programmatically. `${var@Q}` uses single-quote style (`shellQuote`, `src/quote.ts`): safe charset bare, control chars as ANSI-C `$'…'`, else single-quoted with embedded `'` → `'\''`. `printf %q` uses bash's BACKSLASH style (`shellQuoteBackslash`): special chars are `\`-escaped (`a\ b`), control chars share the `$'…'` path; it honors width/left-justify like the other conversions. The two styles legitimately differ — both re-input identically. | **done** |
| `${var@U}` / `@u` / `@L` / `@E` parameter transforms | Programmatic case-folding and ANSI-C escape expansion: `@U` uppercases all, `@u` uppercases the first char, `@L` lowercases all, `@E` expands backslash escapes (`\n`/`\t`/`\xHH`/`\0nnn`, via the shared `interpretEscapes` in `src/escape.ts`, also used by `printf`). `@Q` (quote) was already done. The remaining `@A`/`@a`/`@P`/`@K`/`@k` forms are still accepted but return the value unchanged (see Pending). | **done** |
| `let` arithmetic-evaluation builtin | `let "x = 2 + 3"` / `let i+=1` — agents porting bash scripts hit it. Evaluates each expression over the live env (assignments take) via the same arithmetic evaluator `(( ))` uses (`ctx.evalArith`); exit status is 1 when the LAST expression is 0, else 0 (no args → 1). | **done** |
| `declare -n` namerefs (single-level) | Indirect variable references in helper-function libraries: `declare -n ref=target` makes reads of `$ref` resolve `$target` and writes to `ref` redirect to `target`. SINGLE-LEVEL only (no nameref chains) — recorded on the executor and dereferenced in `Environment` reads + `applyAssignment` writes. | **done** |
| `dirs` / `pushd` / `popd` directory stack | Directory-stack navigation in multi-step scripts. `pushd DIR` (push cwd, cd to DIR, print), bare `pushd` (swap top two), `popd` (pop + cd + print), `dirs` (print cwd-first, `~`-abbreviated unless `-l`; `-c` clears). The stack is backed on the executor (`ShellState.dirStack()`); `pushd`/`popd` reuse `cd`'s `resolvePath` + set `PWD`. Rotation forms (`pushd +N` / `popd +N`) are a documented follow-up (see Pending). | **done** |
| `$LINENO` | Error reporting / `trap ... ERR` diagnostics reference the failing line number. As shipped: the lexer stamps each token with its 1-based start line, the parser records it on each `Statement`, and the executor exposes the current statement's line as the dynamic special var `$LINENO` (1-based per source line, matching bash `-c`). Here-doc body lines and `&&`/`||` continuation lines are counted correctly (the parser keeps blank placeholders for consumed here-doc bodies and stamps each pipeline with its own line). | **done** |
| `readonly` re-assignment rejection | `readonly RO=1; RO=2` is rejected: the old value is kept and a `shell: RO: readonly variable` diagnostic is written. The `readonly` builtin records names on the executor's readonly set (after applying its own `NAME=val`, so the first assignment succeeds); `applyAssignment` checks it. In posix mode the rejection throws `PosixSpecialBuiltinError` (the assignment-error fatal path of POSIX 2.8.1 — see above); outside posix mode it reports + continues with status 1. | **done** |

---

## Pending — gaps this wave does NOT close (`pending`)

Prioritized for agents. Each row: the gap + a one-line agent use case.

| Feature | AI-agent use case | Status |
|---------|-------------------|--------|
| **remaining `${var@OP}` transforms** (`@A @a @P @K @k`) | `@Q @U @u @L @E` are done; the rest (declare-form `@A`/`@a`, prompt-expand `@P`, key/value quote `@K`/`@k`) are format/context-dependent and low agent value — accepted but return the value unchanged | **pending** |
| **`pushd +N` / `popd +N` rotation** | Rotating the directory stack by index; the core `pushd DIR`/bare-`pushd`-swap/`popd`/`dirs` forms are done (see above), the numeric-rotation forms are a follow-up | **pending** |
| **completion builtins** (`complete`/`compgen`/`compopt`) | Interactive completion — low priority for non-interactive agents | **pending** |
| **`read -s` (silent)** | No TTY in the sandbox; secret prompting not meaningful here | **pending** |
| **`hash`** | Command-location caching — irrelevant in the sandbox (no PATH hash table to manage) | **pending** |
| **full coproc** | Bidirectional co-process pipes; only partial support today | **pending** |
| **pipeline final-stage streaming** | The last pipeline stage streaming output incrementally (vs buffering) for long-running agent pipelines | **pending** |

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
