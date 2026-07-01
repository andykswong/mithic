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
| **remaining `${var@OP}` transforms** (`@A @P @K @k`) | `@Q @U @u @L @E @a` are done (`@a` returns attribute flags `r`/`n`/`a`/`A`); the rest (declare-statement reconstruction `@A`, prompt-expand `@P`, assoc key/value quote `@K`/`@k`) are format/context-dependent and low agent value — accepted but return the value unchanged | **pending** |
| **`coproc` on relay backends** | `coproc` is fully implemented (grammar, `execCoproc`, `COPROC`/`COPROC_PID`, e2e tests) on the TRANSFERABLE backends (Worker/iframe); on the relay backends (quickjs/ivm) it emits `shell: coproc: requires a transferable backend` (status 1) — the same relay-port limitation as relay stdin. Closing it needs a relay duplex-pipe channel. | **pending** (runtime done) |
| **pipeline final-stage streaming** | Simple-command pipelines stream via the concurrent kernel path; a COMPOUND-stage pipeline (`yes \| { head -n3; }`) routes to the serialized in-process `execNodePipeline`, which buffers a stage to completion. Deadlock regression test closed; principled fix routes simple-command stages through `runPipeline`. | **pending** |
| **builtin-first pipeline stage `< file`** | A `< file` redirect on a pipeline's FIRST stage is dropped when that stage is a BUILTIN: `cat < f \| cat` yields empty output (the redirect never installs). The external-first-stage form works — `grep x < f \| cat` reads the file. | **pending** |
| **subshell `( … )` redirects** | A subshell group does not apply its own redirects: `( … ) < file` and `( … ) > out` are dropped. An inner `read` in `( read x ) < file` therefore falls through to the (unfed) root stdin and blocks. Use a brace group `{ …; } < file` (which does install the stream) instead. | **pending** |
| **binary through a `< file` redirect** | Builtin stdin is now a `ReadableStream<Uint8Array>`: `cat`/`read`/`mapfile` consume it incrementally, `cat` streams it (binary-exact, no full buffering), sequential reads share one cursor, and a compound statement's `< file` installs the stream — so `while read … < file` and `{ read; read; } < file` no longer hang. A here-string, a pipe, and direct guest stdin are all byte-exact. Still NOT byte-exact: a `< file` redirect reads the file through the FsClient's string `fsRead`, so a binary FILE via `<` round-trips through UTF-8 (invalid bytes become U+FFFD). Reading the file byte-exact requires passing it as a command argument (`cat file`) or through a pipe. | **pending** |
| **binary through an in-process COMPOUND pipeline stage** | A spawned guest's stdout/stderr reach the terminal (and a captured last pipeline stage) byte-exact, and a simple-command pipe carries stdin byte-exact. But an in-process COMPOUND pipeline stage still buffers its stdin to a string (`cat file \| { read h; cat; }` corrupts non-UTF-8 bytes), the same buffering as the `yes \| { head; }` streaming case. | **pending** |

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
