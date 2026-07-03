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

A follow-up **July 2026 "architectural gaps" wave** then closed the four items that
had been parked here as "out of scope," each verified byte-exact against a real
**bash 5.3.15**: (1) **printf 64-bit `intmax_t`/`uintmax_t`** via BigInt (`%x -1` →
`ffffffffffffffff`, exact `%d 9223372036854775807`, out-of-range = exit-1 error);
(2) **`type -a` / `command -v|-V` `$PATH` resolution** over the VFS (incl. `-P`
force-search, clustered flags, `--`, default PATH); (3) **`declare`/`local`/
`readonly`/`export`/`typeset` NAME=(…) array-literal** (parser routes assignment-
builtin operands as assignment words; `[k]=v` elements, `-g` global scope, local
array scoping, prefix-transient); (4) **name-keyed `@`-transforms on array/assoc
elements** (`@a`/`@A`/`@P`/`@K`/`@k`) + the `${a[@]OP}` whole-array/per-element
transforms + `@Q` always-quote with named/octal control escapes. Also migrated
**`$(( ))` arithmetic to 64-bit BigInt** (matching printf) and fixed bare-array-name
transforms (element [0]) and bare-assignment-in-function global scoping.

A further **July 2026 "frontier" wave** then closed the low-level bash-5 items that
had been documented below as intentional boundaries, again byte-exact vs bash 5.3.15:
(5) **`printf` round-half-to-even** — `%f`/`%e`/`%g` now round exact ties to even
against the true IEEE-754 value via an exact BigInt rational (`printf '%.0f' 2.5` →
`2`, `3.5` → `4`), so ties match C/bash; non-tie values are unchanged. (6) **`printf
%#`** forces a trailing decimal point on `%f`/`%e` (`%#.0f 3` → `3.`); `%#g`/`%#o`/
`%#x` were already correct. (7) **`printf` invalid/missing format character** — a
trailing/bare `%…` prints its prefix then errors `\`%…': missing format character`
(exit 1) and a bad conversion char errors `\`X': invalid format character`; C length
modifiers (`h hh l ll L j z t`) are consumed and ignored. (8) **`test`/`[` file
tests + diagnostics** — `-e`/`-f`/`-d`/`-v`/`-o`/`-ef` are now REAL VFS/state tests
(previously `-f`/`-d`/`-e` fell through to a string test, so `[ -f /nonexistent ]`
wrongly returned true), the full unary/binary operator set is recognized, and a
malformed expression emits bash's diagnostic (`X: unary operator expected`,
`X: binary operator expected`, `too many arguments`) with exit 2 — sharing the same
`condFileTest` logic as `[[ ]]`. (9) **`declare`/`typeset`/`local -l`/`-u`** case-fold
attribute folds every assigned value (scalar/array/element/`+=`), `-lu` cancels,
`+l`/`+u` clears (matching direction only), and `declare -p` shows `-l`/`-u` (flag
order `a i r x l/u`).

A **5-dimension adversarial bash-5.3 differential review** of the frontier wave then
found 13 further confirmed divergences, fixed here (again byte-exact vs bash 5.3.15):
two were REGRESSIONS the wave introduced — `[ -e '' ]`/`[ -f '' ]` wrongly true (an
empty path must be nonexistent, not resolved to the cwd), and `+u` on a `-l` var (or
`+l` on `-u`) wrongly wiped the whole fold (now clears only the matching direction).
The rest were pre-existing gaps the sharper lens surfaced and completed: `printf`
hex-integer / C hex-float args (`%f 0x10` → `16.0`, `%f 0x1.8p3` → `12.0`); `inf`/
`nan`/`infinity` literal float args (any case) formatted as `inf`/`-inf`/`nan` (and
`INF`/`NAN` for `%F`/`%E`/`%G`) with sign + width but no zero-fill, and an overflowing
magnitude prints `inf` not JS `Infinity`; `%#g`/`%#G` force a trailing point on
integer-valued output (`%#g 100000` → `100000.`); the conversions `%a`/`%A` (C99 hex
float, ties-to-even), `%F` (uppercase-inf `%f`), `%S`/`%C` (wide aliases), and `%n`
(no-op); and `[[ ]]` gained `( … )` grouping and the `-ef`/`-nt`/`-ot` binops.

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
- **An UNQUOTED associative-array key containing whitespace in an array literal**
  (`declare -A m=([a b]=X)`) is not collected — the lexer splits the `[a b]` at the
  blank (the same rule that keeps `[ -f x ]` test syntax from being swallowed as a
  glob bracket). The QUOTED forms all work and match bash: `declare -A m=(["a b"]=X)`
  and `m["a b"]=X`. Only the rare unquoted-space-in-subscript literal falls through;
  fixing it would require the lexer to disambiguate an assoc subscript from a test
  command at tokenize time (ambiguous, high blast radius). Quote the key.
- **Assigning to a readonly variable is not FATAL to a `-c` command string.** bash
  aborts a `bash -c '…'` (only) on a readonly-variable assignment error (`readonly x=5;
  x=9; echo after` prints nothing, exit 1), but a readonly reassignment in a *script
  file* is non-fatal (the rest runs). mithic reports the error + exit 1 and CONTINUES
  in both cases (matching the script-file behavior). It has no `-c`-vs-script-file
  distinction in the Executor, and POSIX mode already makes readonly-reassign fatal;
  the non-posix `-c`-only abort is a narrow bash quirk not worth a mode flag.
- **`printf %c` / `%.1s` of a multibyte argument emits a whole codepoint, not the
  first BYTE.** bash's byte-oriented `printf '%c' 'é'` writes one UTF-8 byte (`0xc3`);
  mithic's JS-string interpreter emits the first code UNIT (the whole `é`, or a lone
  surrogate half for an astral char). ASCII `%c` matches bash exactly. Faithful
  single-byte output would require a byte-oriented printf rewrite over the JS-string
  surface — out of scope; the common ASCII case is correct.
- **`test`/`[` file tests that need permission / size / owner / type / mtime metadata
  degrade to existence-or-false.** The sandbox `FsClient.fsStat` exposes only `{dir}`,
  so `-r`/`-w`/`-x`/`-s`/`-O`/`-G`/`-N`/`-u`/`-g`/`-k`/`-a` report true for any
  existing path (the common bash result for readable/writable/nonempty files), and the
  type/symlink tests `-h`/`-L`/`-b`/`-c`/`-p`/`-S`/`-t` plus the mtime binops
  `-nt`/`-ot` report false. `-e`/`-f`/`-d`/`-v`/`-R`/`-o`/`-ef` are exact. Faithful
  permission/mtime tests would need a richer VFS stat — out of scope.
- **`printf %(FMT)T` (strftime timestamp) is not implemented.** bash's
  `printf '%(%Y-%m-%d)T' SECONDS` formats a time_t via `strftime`. mithic reports it
  as an invalid format character. A faithful port needs a `strftime` engine + locale/TZ
  handling; low use in agent scripts. (The C99 float/wide conversions `%a`/`%A`/`%F`/
  `%S`/`%C` and the no-op `%n` ARE implemented and byte-exact vs bash.)
- **`printf` does not emit the ERANGE `Result too large` diagnostic for an underflowing
  (subnormal-rounding) float argument.** bash prints the rounded value AND exits 1 with
  `ARG: Result too large` for e.g. `printf '%g' 5e-324`; mithic prints the byte-identical
  value but exits 0 with no diagnostic. Only the exit code + stderr differ, never stdout;
  detecting it would need the parse path to flag sub-`DBL_MIN` magnitudes.
- **A `printf` invalid-format-character diagnostic quotes the DECODED byte when a
  backslash escape sits at the conversion position.** `printf '%\n'` reports
  `` `<LF>': invalid format character `` (the interpreted newline) where bash quotes the
  literal `` `\' ``. Cosmetic (stderr text only); the exit code and stopped-output match.
  The format string is escape-interpreted before spec parsing, so the raw escape is gone
  by the time the error fires.
- **`test`/`[` accepts DEEPLY nested parentheses that bash's argc-driven parser rejects.**
  `[ '(' '(' x ')' ')' ]` is true in mithic (its recursive grammar allows nesting) but
  bash errors (`(: unary operator expected`, exit 2) — bash only special-cases a SINGLE
  `( expr )` level in `[ ]`. mithic is more permissive, not less; single-level grouping
  and the common cases match. (`[[ ( ( … ) ) ]]` nests fine in both.)
- **`declare -l`/`-u` uses JS full Unicode case mapping where bash uses simple
  per-codepoint mapping.** `declare -u x=ß` → `SS` (mithic, `String.toUpperCase`) vs `ß`
  (bash, `towupper` 1:1); likewise the ligature `ﬁ`→`FI` and `İ`→`i̇`. ASCII and
  precomposed accented Latin (`déjà`→`DÉJÀ`) match exactly; only the rare 1-to-many /
  special-casing codepoints differ. A faithful port would map each code point through the
  Unicode SIMPLE case mapping only.
- **`readonly`/`export` do not reject `declare`-only option letters.** `readonly -l x`
  (or `-u`/`-i`) is silently accepted and applies the attribute; bash's `readonly`
  accepts only `-aAfp` and errors `-l: invalid option` (exit 2). The shared assignment-
  builtin flag scanner does no per-builtin option validation — mithic is more permissive,
  never less; the correct forms (`declare -rl`, `declare -ri`) behave identically.
- **`declare -FLAG` with no name operands does not list matching variables, and
  `declare +l NAME` does not pre-declare an unset variable.** `declare -i` / `declare -l`
  (no names) prints nothing where bash lists every var carrying that attribute; `declare
  +l newvar` leaves `newvar` unset-and-unknown where bash creates it (`declare -- newvar`).
  Attribute-flag *listing mode* and *bare-declaration* are interactive-leaning; the common
  assignment/fold paths and `+l` on an existing var are exact.
- **`[[ ]]` does not emit bash's parse-time diagnostics for a malformed expression.** A
  missing operand / unbalanced literal paren / unknown operator (`[[ -e ]]`, `[[ ( a ]]`,
  `[[ x -badop y ]]`) evaluates to false (exit 1) rather than bash's `syntax error` / 
  `conditional binary operator expected` (exit 2). A well-formed `[[ ]]` — including
  `( )` grouping, `&&`/`||`, and all operators — matches bash; only the diagnostic on
  malformed input differs.
- **A `[[ ]]` `=~` regex containing an UNQUOTED `&&`/`||`, or an unquoted backslash
  escape, is mis-parsed.** `[[ "a&&b" =~ (a&&b) ]]` truncates the regex at the `&&`
  (the lexer treats it as a shell connective), and `[[ '(' =~ ^\($ ]]` has its `\(`
  backslash stripped by word expansion before the regex compiles. QUOTE the regex to be
  safe: `[[ "a&&b" =~ "a&&b" ]]` — a quoted `=~` operand is a literal-string match in
  bash but mithic treats it as a live regex, another narrow divergence. These live in
  the `=~` lex/expansion path (predating the `( )`-grouping work, which itself is exact);
  ordinary regexes — anchors, classes, alternation, backrefs, and grouped patterns like
  `([a-z]+)([0-9]+)`, including inside `[[ ( … ) ]]` — match bash.
- **`declare -g` on a name a function-local shadows has two narrow scoping gaps.** A
  `declare -gA m=([k]=v)` (associative-array literal) whose name is shadowed by a local
  `-A` drops the `-A` attribute and the key (it commits as an indexed array), and a
  scalar `declare -g NAME+=v` append reads the LOCAL shadow's value rather than the
  global's. The common `-g` paths (scalar/array/element assignment, fold by the global
  attribute, `declare -p`) match bash; only these two shadow-interaction corners differ.
  Both predate the case-fold work and need a global-binding value/assoc accessor
  symmetric to `setGlobal`/`globalCaseFoldOf` — low blast radius (a `-g` write to a
  same-name local-shadowed assoc/append inside a function is rare).

---

## Future: command-level (coreutils) comparison

The comparison harness here only covers shell-language behavior. Comparing mithic's
coreutils (`ls`, `grep`, `cat`, `jq`, `curl`, …) against their GNU/BSD counterparts
requires driving the **real kernel** and spawning guests (not the mock-kernel
`Executor` surface), plus a stable VFS fixture tree. That is a separate, heavier
harness and is intentionally out of scope for this registry.
