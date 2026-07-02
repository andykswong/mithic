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

_No open shell-language or shell/runtime gaps are currently tracked._ The July 2026
bash-parity gap wave (63 verified gaps found by a fresh differential sweep against
real `/bin/bash`) shipped: `$'…'` ANSI-C quoting, `\<newline>` continuation, nested
`"$(… "…")"` lexing, `;&`/`;;&` case-fallthrough, IFS-aware word-splitting
(`splitParts` + `read`/`read -a`), param-expansion fixes (`${v/%pat/r}` suffix
anchor, `${!ref}OP` indirection, `${arr[@]:o:l}` element slicing, `${@:o:l}`
positional slice, arithmetic offsets, negative index), arithmetic `base#num` literals
+ `declare -i` + array-element lvalues + hex-width-fix + history-expansion
interactive-only, builtins/vars (`test` operators `-a`/`-o`/lexical `<>`/3-arg
negation, `[[ ]]` lexical `<>`, `command`/`builtin`, `type -t/-a`, `declare -r/-p`,
`$FUNCNAME`, `$BASH_REMATCH` incl. grouped-regex fix, `$_`, `$SECONDS`), printf
(invalid-number diagnostic+exit 1, `%*d` negative dynamic width, `%b \c`
output-stop), and `DEBUG`/`RETURN` traps. Previously-shipped items (through June
2026) were already removed per the open-only convention.

## Deliberate boundaries (documented, not gaps)

These are intentional design limits, not missing features:

- **`TMOUT` interactive idle-exit.** bash auto-exits an *interactive* shell after
  `$TMOUT` idle seconds at the prompt. There is no interactive prompt loop in the
  non-interactive sandbox, so this belongs to an example-app REPL, not shell core.
  (`read -t N` block-then-timeout over a live stream DOES work — that half shipped
  with byte-stream stdin.)
- **A relay guest cannot spawn a relay child from a suspended syscall.** On the
  relay backends (quickjs/ivm), a guest suspended mid-syscall cannot spawn a child
  guest (QuickJS Asyncify re-entrancy → `gc_obj_list` abort; ivm hangs). This
  affects ALL relay child-spawn (`coproc`/pipelines/`process/spawn` from a relay
  *shell*), not just coproc — the coproc pipe wiring itself is complete + tested.
  Shipped shells run on the transferable (Worker/iframe) backends, where this does
  not apply; relay backends are the deterministic single-purpose tier.
- **`read -n N` / `-d DELIM` combined with `<&N` (or `-u N`) over a duplex/input fd**
  reads a whole line/datagram, ignoring the count/delimiter — an inherited limit of
  the numbered-fd read path. Chunked reads over pipe/here-string stdin honor `-n`/`-d`
  normally; the UDP round-trip uses whole-datagram `read -r`.
- **`type -a NAME` lists builtins/functions/keywords but NOT PATH files.** The pure
  builtin surface has no real `$PATH` search — external commands are resolved by the
  kernel's `resolveCommand`, which is not callable from the `type` builtin. `type -t`
  (which only classifies known names) is correct; `-a`'s PATH-hit listing is partial.
- **printf `%x`/`%u`/`%o`/`%d` of very large or negative integers uses JS double
  precision (52-bit mantissa) and 32-bit unsigned reinterpretation**, not bash's
  64-bit `intmax_t`. `printf '%x' -1` → `ffffffff` (32-bit) vs bash's
  `ffffffffffffffff` (64-bit); `printf '%d' 9223372036854775807` loses precision
  beyond 2^53. Full 64-bit parity would require BigInt arithmetic throughout — out
  of scope. The common ≤ 32-bit range is correct.
- **`declare`/`local`/`readonly` NAME=(…) array-literal is not applied.**
  `declare -a arr=(a b c)` leaves `arr` empty — the parenthesised element list is
  a separate token the declaration builtins do not collect (the array literal only
  works as a bare assignment `arr=(a b c)`, no `declare` prefix). Pre-existing.
- **`declare -i` on an ARRAY does not arithmetic-evaluate element assignments.**
  `declare -i a; a[0]=3+4` stores `3+4` (bash: `7`). The integer attribute is
  applied on scalar assignments only. Pre-existing; use `(( a[0]=3+4 ))` which
  evaluates correctly.
- **`${arr[i]@Q}` / `@U` / `@L` transforms are not applied to array/assoc
  elements** (they return the raw element). Element access supports the full
  string-operator set (`:-`, `#`, `%`, `/`, `^`, `,`, `:off:len`) but not the
  `@`-transforms. Pre-existing; scalar `${var@Q}` etc. work.

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
