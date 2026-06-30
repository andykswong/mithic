# `@mithic/shell` — Known Limitations & bash-parity registry

This document tracks where the Mithic shell (`@mithic/shell`) intentionally or
not-yet diverges from real bash, prioritized for AI-agent use cases (agents running
shell scripts in the sandbox). It is the companion to the bash-comparison
golden-fixture harness in `src/comparison/` (see "Comparison harness" below).

Status legend: **pending** = not yet implemented; **divergence** = a deliberate,
documented difference from bash. This registry tracks **open** items only — once a gap
is closed (shipped + tested), its row is removed rather than marked done.

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

---

## Deliberate divergences (mithic ≠ bash, on purpose)

| Behavior | bash | mithic | AI-agent note | Status |
|----------|------|--------|---------------|--------|
| **Brace expansion in POSIX mode** | bash KEEPS brace expansion on in posix mode (`echo {a,b,c}` → `a b c` under `--posix`/`set -o posix`/`POSIXLY_CORRECT=1`) | mithic SUPPRESSES it (`{a,b,c}` literal) — matches a true POSIX `sh` (dash), stricter than bash | Agents enabling `set -o posix` for strict scripts get dash-style brace handling, not bash-style. Fixture `brace-suppressed-posix.json` holds the bash golden; the case is `.skip`-ped in `shell-behavior.comparison.test.ts`. | **divergence** |

---

## Pending — open gaps (`pending`)

Prioritized for agents. Each row: the gap + a one-line agent use case.

| Feature | AI-agent use case | Status |
|---------|-------------------|--------|
| **remaining `${var@OP}` transforms** (`@A @a @P @K @k`) | `@Q @U @u @L @E` are done; the rest (declare-form `@A`/`@a`, prompt-expand `@P`, key/value quote `@K`/`@k`) are format/context-dependent and low agent value — accepted but return the value unchanged | **pending** |
| **`pushd +N` / `popd +N` rotation** | Rotating the directory stack by index; the core `pushd DIR`/bare-`pushd`-swap/`popd`/`dirs` forms are implemented, the numeric-rotation forms are a follow-up | **pending** |
| **`readonly` enforcement — narrow gaps** | Core `readonly` enforcement is implemented; still NOT enforced: a `for X in …` loop variable, a `getopts` var, and a `X=2 cmd` prefix-overlay can overwrite a readonly, and `${ref:=x}` default-assign through a nameref writes the literal ref name | **pending** |
| **completion builtins** (`complete`/`compgen`/`compopt`) | Interactive completion — low priority for non-interactive agents | **pending** |
| **`read -s` (silent)** | No TTY in the sandbox; secret prompting not meaningful here | **pending** |
| **`hash`** | Command-location caching — irrelevant in the sandbox (no PATH hash table to manage) | **pending** |
| **`coproc` on relay backends** | `coproc` is fully implemented (grammar, `execCoproc`, `COPROC`/`COPROC_PID`, e2e tests) on the TRANSFERABLE backends (Worker/iframe); on the relay backends (quickjs/ivm) it emits `shell: coproc: requires a transferable backend` (status 1) — the same relay-port limitation as relay stdin. Closing it needs a relay duplex-pipe channel. | **pending** (runtime done) |
| **pipeline final-stage streaming** | Simple-command pipelines stream via the concurrent kernel path; a COMPOUND-stage pipeline (`yes \| { head -n3; }`) routes to the serialized in-process `execNodePipeline`, which buffers a stage to completion. Deadlock regression test closed; principled fix routes simple-command stages through `runPipeline`. | **pending** |

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
