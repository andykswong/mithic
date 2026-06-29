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
  the first committed suite was chosen to produce **identical** output on bash 3.2
  AND bash 5.x.
- **bash-4+ cases** (e.g. `case-upper` / `${s^^}`) are hand-recorded from known
  bash-5 output, because recording them on bash 3.2 would capture a `bad
  substitution` error as golden. `compareWithBash4(...)` refuses to record on the
  default host unless `RECORD_BASH4=1` is also set (signalling a bash-4+ host).

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
| POSIX special-builtin fatality (POSIX 2.8.1) — **partial** | A bad `set` option now aborts a non-interactive shell in posix mode (no silent continue), via `PosixSpecialBuiltinError`. **Scope today: only `set`'s bad-option path throws.** The canonical redirect/assignment-error-on-a-special-builtin case (`export x=1 >/bad`) still returns 1 and continues — wiring `withRedirects`/assignment errors to the same fatal path is a follow-up (see "Pending"). | **partial** |
| Process substitution `<(…)`/`>(…)` rejected in POSIX mode | Agents in strict posix mode get a clear rejection instead of a bash-only extension | **done** |
| `read -r` (raw — no backslash mangling) | `read -r line` preserves backslashes; the prior silent `-r` ignore was a correctness trap | **done** |
| `read -a` / `read -d` / `read -n` / `read -N` (incl. clustered `-ra`/`-rn3`) | Parse a line into an array; NUL/custom delimiters (`find -print0`); `-n` (≤N, stop at delim) and `-N` (exactly N, ignore delim); short flags cluster like bash (`read -ra arr`, `read -rn3 x`) | **done** |
| `mapfile` / `readarray` | Slurp multi-line output into an array (`mapfile -t lines`) | **done** |

---

## Pending — gaps this wave does NOT close (`pending`)

Prioritized for agents. Each row: the gap + a one-line agent use case.

| Feature | AI-agent use case | Status |
|---------|-------------------|--------|
| **`$LINENO`** | Error reporting / `trap ... ERR` diagnostics reference the failing line number | **pending** |
| **`${var@Q}` / `printf %q`** | Safely quote a string when an agent generates shell commands programmatically | **pending** |
| **`let`** | Arithmetic-evaluation builtin (`let i+=1`); agents porting bash scripts hit it | **pending** |
| **`dirs` / `pushd` / `popd`** | Directory-stack navigation in multi-step scripts | **pending** |
| **`declare -n` (namerefs)** | Indirect variable references; common in helper-function libraries | **pending** |
| **completion builtins** (`complete`/`compgen`/`compopt`) | Interactive completion — low priority for non-interactive agents | **pending** |
| **`read -s` (silent)** | No TTY in the sandbox; secret prompting not meaningful here | **pending** |
| **full coproc** | Bidirectional co-process pipes; only partial support today | **pending** |
| **pipeline final-stage streaming** | The last pipeline stage streaming output incrementally (vs buffering) for long-running agent pipelines | **pending** |
| **special-builtin fatality: redirect/assignment path** | POSIX 2.8.1's canonical case — a redirection or assignment error on a special builtin (`export`/`readonly`/`.`) aborts the shell in posix mode. Only `set`'s bad-option path is fatal today; thread `withRedirects`/assignment errors through `PosixSpecialBuiltinError` too | **pending** |

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
