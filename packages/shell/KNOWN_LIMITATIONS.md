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

_No open shell-language or shell/runtime gaps are currently tracked._ Per the open-only
convention, closed work is not narrated here — the shipped bash-parity waves (through
July 2026, incl. the 64-bit-`intmax_t`/`$PATH`-resolution/array-literal/`@`-transform
"architectural" wave, the printf-rounding/format-char/test-diagnostics/case-fold
"frontier" wave, its multi-round adversarial review, and the `[[ ]]`/`[[ =~ ]]`/`declare`
known-bug closeout) have been removed from this open-only registry. Only genuine,
still-open divergences live below.

## Deliberate boundaries (documented, not gaps)

Intentional design limits, not missing features. The governing rule: a boundary must
be **fail-loud** (report an error + nonzero exit), **inert-by-design** (a graceful,
documented no-op with a test), or **more-permissive** (accepts a superset of bash but
never yields a *wrong* result) — **never silently wrong** (a plausible-but-incorrect
value with no signal). Each row states which class it is. (Divergences that WERE
silently wrong — `[ -f /nonexistent ]`→true, the perm/size/mtime file-test
degradation, the printf-underflow ERANGE miss — have been fixed, not documented here.)

### Inert-by-design (graceful no-op, no wrong output)

- **`TMOUT` interactive idle-exit.** bash auto-exits an *interactive* shell after
  `$TMOUT` idle seconds at the prompt. There is no interactive prompt loop in the
  non-interactive sandbox, so this belongs to an example-app REPL, not shell core.
  (`read -t N` block-then-timeout over a live stream DOES work — that half shipped
  with byte-stream stdin.)
- **A relay guest cannot spawn a relay child from a suspended syscall.** On the
  relay backends (quickjs/ivm), a guest suspended mid-syscall cannot spawn a child
  guest (QuickJS Asyncify re-entrancy → `gc_obj_list` abort; ivm hangs) — a *fail-loud*
  substrate limit, not a wrong result. Affects ALL relay child-spawn
  (`coproc`/pipelines/`process/spawn` from a relay *shell*), not just coproc — the
  coproc pipe wiring itself is complete + tested. Shipped shells run on the transferable
  (Worker/iframe) backends, where this does not apply; relay backends are the
  deterministic single-purpose tier.
- **`read -n N` / `-d DELIM` combined with `<&N` (or `-u N`) over a duplex/input fd**
  reads a whole line/datagram, ignoring the count/delimiter — an inherited limit of
  the numbered-fd read path. It reads *more* than asked, never wrong bytes. Chunked
  reads over pipe/here-string stdin honor `-n`/`-d` normally; the UDP round-trip uses
  whole-datagram `read -r`.
- **`printf %(FMT)T` (strftime timestamp) is not implemented — FAIL-LOUD.** `printf
  '%(%Y-%m-%d)T' SECONDS` reports `` `(': invalid format character `` (exit 1), not a
  wrong date. A faithful port needs a `strftime` engine + locale/TZ handling; low use
  in agent scripts. (The C99 float/wide conversions `%a`/`%A`/`%F`/`%S`/`%C` and the
  no-op `%n` ARE implemented and byte-exact vs bash.)

### More-permissive (accepts a superset of bash; never a wrong result)

- **An UNQUOTED associative-array key containing whitespace in an array literal**
  (`declare -A m=([a b]=X)`) is not collected — the lexer splits the `[a b]` at the
  blank (the same rule that keeps `[ -f x ]` test syntax from being swallowed as a
  glob bracket). The QUOTED forms all work and match bash: `declare -A m=(["a b"]=X)`
  and `m["a b"]=X`. Quote the key. (Neither silently wrong nor lossy — the unquoted
  literal simply isn't a supported spelling.)
- **`test`/`[` accepts DEEPLY nested parentheses that bash's argc parser rejects.**
  `[ '(' '(' x ')' ')' ]` is *true* in mithic (its recursive grammar evaluates the
  inner `x` — the semantically-correct answer); bash errors on a parse quirk (`(: unary
  operator expected`, exit 2). More-permissive PARSE, not a wrong truth value;
  single-level grouping and the common cases match. (`[[ ( ( … ) ) ]]` nests in both.)

### Cosmetic / narrow (documented, not worth the fix)

- **`printf %c` / `%.1s` of a multibyte argument emits a whole codepoint, not the
  first BYTE.** bash's byte-oriented `printf '%c' 'é'` writes one UTF-8 byte (`0xc3`);
  mithic's JS-string interpreter emits the first code UNIT. ASCII `%c` matches bash
  exactly. A byte-oriented printf rewrite over the JS-string surface is out of scope.
- **`declare -l`/`-u` uses JS full Unicode case mapping where bash uses simple
  per-codepoint mapping.** `declare -u x=ß` → `SS` (mithic) vs `ß` (bash `towupper`
  1:1); likewise `ﬁ`→`FI`, `İ`→`i̇`. ASCII + precomposed accented Latin (`déjà`→`DÉJÀ`)
  match; only the rare 1-to-many / special-casing codepoints differ.
- **A `printf` invalid-format-character diagnostic quotes the DECODED byte when a
  backslash escape sits at the conversion position.** `printf '%\n'` reports
  `` `<LF>': invalid format character `` where bash quotes the literal `` `\' ``.
  Cosmetic (stderr text only); the exit code and stopped-output match.
- **Assigning to a readonly variable is not FATAL to a `-c` command string.** bash
  aborts a `bash -c '…'` (only) on a readonly-assignment error; mithic reports the
  error + exit 1 and CONTINUES (matching the script-file behavior — it has no
  `-c`-vs-script distinction). POSIX mode already makes readonly-reassign fatal.

_No known-buggy divergences are currently tracked._ The four that were listed here
(the `[[ ]]` malformed-expression fabricated-false, the `[[ =~ ]]` unquoted-backslash /
quoted-literal mis-expansion, `declare -FLAG` attribute-listing + bare-predeclaration,
and the `declare -g` assoc-literal / `+=`-append scoping gaps) have shipped — each now
matches bash 5.3 byte-for-byte, with regression tests in `src/executor-features.test.ts`.

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
