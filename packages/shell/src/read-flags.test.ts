/* eslint-disable @typescript-eslint/no-explicit-any -- read-flags tests use a minimal mock kernel */
/**
 * Task 5 — `read` flags (`-r`/`-a`/`-d`/`-n`) + `mapfile`/`readarray`.
 *
 * stdin is fed with the pipe-into-a-group idiom (`printf … | { read … ; echo … }`)
 * so the bytes reach `read` as the group's materialized STRING stdin — the same
 * mechanism the existing read tests use (see bash-vars.test.ts / read-livestdin.test.ts).
 * Literal backslashes are fed via `printf '%s\n' 'a\b'` (a `%s` arg) so printf
 * does not escape-interpret them — the data on stdin is exactly `a\b`.
 *
 * `read -r` is the correctness fix: plain `read` treats backslash as an escape
 * (mangling `a\b` → `ab`), `read -r` must preserve it verbatim (`a\b`).
 */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mockKernel() {
  return { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
}

function mk() {
  let out = '';
  let err = '';
  const ex = new Executor(mockKernel() as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

// ── read -r (raw) — the correctness trap ─────────────────────────────────────

test('read -r preserves backslashes (no mangling)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'a\\b\' | { read -r x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[a\\b]');
});

test('plain read treats backslash as an escape (the documented bash default)', async () => {
  const h = mk();
  // bash: `a\b` → `ab` (backslash removed, the next char taken literally).
  await h.ex.exec('printf \'%s\\n\' \'a\\b\' | { read x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[ab]');
});

// ── clustered short flags (bash: `read -ra arr`, `read -rn3 x`) ──────────────

test('read -ra splits into an array (clustered -r + -a)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'one two three\' | { read -ra parts; echo "${parts[0]}-${parts[2]} n=${#parts[@]}"; }');
  expect(h.out.trim()).toBe('one-three n=3');
});

test('read -rn3 reads at most 3 chars (clustered -r + -n with attached count)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'abcdef\' | { read -rn3 x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[abc]');
});

test('read -ra preserves backslashes in array fields (raw applies across the cluster)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'a\\b c\' | { read -ra parts; echo "${parts[0]}|${parts[1]}"; }');
  expect(h.out.trim()).toBe('a\\b|c');
});

// ── read -a (split into an array) ────────────────────────────────────────────

test('read -a splits a line into an indexed array variable', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'one two three\' | { read -a parts; echo "${parts[0]}-${parts[1]}-${parts[2]} n=${#parts[@]}"; }');
  expect(h.out.trim()).toBe('one-two-three n=3');
});

test('read -a expands all elements via "${parts[@]}"', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'a b c\' | { read -a parts; echo "${parts[@]}"; }');
  expect(h.out.trim()).toBe('a b c');
});

// ── read -d (custom line delimiter) ──────────────────────────────────────────

test('read -d uses a custom delimiter as the line terminator', async () => {
  const h = mk();
  // ';'-delimited: `read -d ';' x` stops at the first ';' → x == 'first'.
  await h.ex.exec('printf \'%s\\n\' \'first;second\' | { read -d \';\' x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[first]');
});

test('read -d "" reads up to a NUL delimiter', async () => {
  const h = mk();
  // NUL-delimited record: everything up to the first \0.
  await h.ex.exec('printf \'a\\0b\' | { read -d \'\' x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[a]');
});

// ── read -n (max chars) ──────────────────────────────────────────────────────

test('read -n reads at most N characters', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' \'abcdef\' | { read -n 3 x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[abc]');
});

test('read -n stops at the delimiter before N chars', async () => {
  const h = mk();
  // 'ab' is only 2 chars before the newline, so `-n 5` stops at the newline.
  await h.ex.exec('printf \'%s\\n\' \'ab\' | { read -n 5 x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[ab]');
});

test('read -N reads exactly N chars, IGNORING the delimiter', async () => {
  const h = mk();
  // Input 'a\nb' — `-N 3` reads across the newline (delimiter ignored), so the var
  // holds all 3 chars incl. the embedded newline. Assert on length (the embedded
  // newline is preserved in storage; double-quote expansion renders it as a space).
  await h.ex.exec('printf \'a\\nb\' | { read -N 3 x; printf \'len=%s\' "${#x}"; }');
  expect(h.out).toBe('len=3');
});

test('read -n (lowercase) stops at the delimiter, unlike -N', async () => {
  const h = mk();
  // Same 'a\nb' input: `-n 3` stops at the newline → only 'a' (1 char).
  await h.ex.exec('printf \'a\\nb\' | { read -n 3 x; printf \'len=%s\' "${#x}"; }');
  expect(h.out).toBe('len=1');
});

// ── mapfile / readarray ──────────────────────────────────────────────────────

test('mapfile -t slurps lines into a 3-element array', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' l1 l2 l3 | { mapfile -t arr; echo "${arr[0]}|${arr[1]}|${arr[2]} n=${#arr[@]}"; }');
  expect(h.out.trim()).toBe('l1|l2|l3 n=3');
});

test('mapfile (no -t) keeps the trailing newline on each element', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' l1 l2 | { mapfile arr; echo "n=${#arr[@]}"; printf \'<%s>\' "${arr[0]}"; }');
  // Each element retains its '\n'; the printf shows the literal newline inside <…>.
  expect(h.out).toContain('n=2');
  expect(h.out).toContain('<l1\n>');
});

test('readarray is an alias of mapfile', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' x y | { readarray -t arr; echo "${arr[0]}-${arr[1]} n=${#arr[@]}"; }');
  expect(h.out.trim()).toBe('x-y n=2');
});

test('mapfile defaults to the MAPFILE array when no name is given', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' p q | { mapfile -t; echo "${MAPFILE[0]}-${MAPFILE[1]} n=${#MAPFILE[@]}"; }');
  expect(h.out.trim()).toBe('p-q n=2');
});

// ── mapfile data-affecting flags (-n / -s / -O), bash-5.3 exact ──────────────

test('mapfile -n 2 copies at most 2 records', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b c d | { mapfile -t -n 2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="a" [1]="b")');
});

test('mapfile -n 0 means all records', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b c | { mapfile -t -n 0 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="a" [1]="b" [2]="c")');
});

test('mapfile -s 2 skips the first 2 records', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b c d | { mapfile -t -s 2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="c" [1]="d")');
});

test('mapfile -s 2 -n 1 skips then limits', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b c d e | { mapfile -t -s 2 -n 1 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="c")');
});

test('mapfile -s beyond the input yields an empty array', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b | { mapfile -t -s 10 arr; declare -p arr; echo "s=$?"; }');
  expect(h.out.trim()).toBe('declare -a arr=()\ns=0');
});

test('mapfile -O 3 stores starting at index 3 (empty array)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' x y | { mapfile -t -O 3 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([3]="x" [4]="y")');
});

test('mapfile -O 2 overwrites from index 2 without clearing elements below or beyond', async () => {
  const h = mk();
  await h.ex.exec('arr=(a b c d e); printf \'%s\\n\' X Y | { mapfile -t -O 2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="a" [1]="b" [2]="X" [3]="Y" [4]="e")');
});

// ── attached-form numeric flags (-n2 / -s2 / -O2, no space): a distinct parse
// branch (flag = a.slice(0,2), value = a.slice(2)) that the spaced-form cases
// above never exercise. Locks the slice offset and the -O vs -n/-s label/target
// selection against a silent future regression. bash-5.3 exact.
test('mapfile -t -n2 (attached) copies at most 2 records', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b c d | { mapfile -t -n2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="a" [1]="b")');
});

test('mapfile -t -s2 (attached) skips the first 2 records', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b c d | { mapfile -t -s2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="c" [1]="d")');
});

test('mapfile -t -O2 (attached) stores starting at index 2 without clearing others', async () => {
  const h = mk();
  await h.ex.exec('arr=(a b c d e); printf \'%s\\n\' X Y | { mapfile -t -O2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="a" [1]="b" [2]="X" [3]="Y" [4]="e")');
});

test('mapfile -O beyond existing length leaves a hole', async () => {
  const h = mk();
  await h.ex.exec('arr=(a b); printf \'%s\\n\' X Y | { mapfile -t -O 5 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="a" [1]="b" [5]="X" [6]="Y")');
});

test('mapfile -O promotes an existing scalar to [0]', async () => {
  const h = mk();
  await h.ex.exec('arr=hello; printf \'%s\\n\' X Y | { mapfile -t -O 2 arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="hello" [2]="X" [3]="Y")');
});

test('mapfile without -O clears the whole pre-existing array (replace, not merge)', async () => {
  const h = mk();
  await h.ex.exec('arr=(a b c d e); printf \'%s\\n\' X Y | { mapfile -t arr; declare -p arr; }');
  expect(h.out.trim()).toBe('declare -a arr=([0]="X" [1]="Y")');
});

// ── invalid numeric operands: bash-exact diagnostics + exit 1 ────────────────

test('mapfile -n with a negative count errors (invalid line count, exit 1)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b | { mapfile -t -n -1 arr; echo "s=$?"; }');
  expect(h.err).toContain('mapfile: -1: invalid line count');
  expect(h.out.trim()).toBe('s=1');
});

test('mapfile -n with a non-numeric count errors (invalid line count, exit 1)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b | { mapfile -t -n xyz arr; echo "s=$?"; }');
  expect(h.err).toContain('mapfile: xyz: invalid line count');
  expect(h.out.trim()).toBe('s=1');
});

test('mapfile -O with a negative origin errors (invalid array origin, exit 1)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' a b | { mapfile -t -O -1 arr; echo "s=$?"; }');
  expect(h.err).toContain('mapfile: -1: invalid array origin');
  expect(h.out.trim()).toBe('s=1');
});

// ── -c/-C callback is unsupported: fail LOUD, never silently ignored ─────────

test('mapfile -C callback fails loud (diagnostic + nonzero status)', async () => {
  const h = mk();
  await h.ex.exec('cb(){ :; }; printf \'%s\\n\' a b | { mapfile -t -C cb arr; echo "s=$?"; }');
  expect(h.err).toContain('not supported');
  expect(h.out.trim()).toBe('s=2');
});

test('mapfile -c quantum (paired with -C) fails loud, never silently ignored', async () => {
  const h = mk();
  await h.ex.exec('cb(){ :; }; printf \'%s\\n\' a b c d | { mapfile -t -c 2 -C cb arr; echo "s=$?"; }');
  expect(h.err).toContain('not supported');
  expect(h.out.trim()).toBe('s=2');
});

// ── A7: read -p PROMPT / read -s consume their operands ──────────────────────

test('read -p PROMPT reads into the named var (prompt operand consumed, not a var name)', async () => {
  const h = mk();
  // Before the fix, `-p` was a no-op so 'Enter: ' became the FIRST var name and
  // `x` got the empty leftover → `[]`. After: the prompt is consumed, x='hello'.
  await h.ex.exec('printf \'%s\\n\' hello | { read -p \'Enter: \' x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[hello]');
});

test('read -s reads normally (silent is a no-op without a TTY)', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' pw | { read -s secret; echo "[$secret]"; }');
  expect(h.out.trim()).toBe('[pw]');
});

test('read -sp PROMPT clustered: prompt consumed, silent no-op, reads into the var', async () => {
  const h = mk();
  await h.ex.exec('printf \'%s\\n\' v | { read -sp \'P: \' x; echo "[$x]"; }');
  expect(h.out.trim()).toBe('[v]');
});

// ── WP-B: read honors IFS ────────────────────────────────────────────────────

test('IFS=: read splits fields on the custom separator', async () => {
  const h = mk();
  await h.ex.exec('IFS=: read a b c <<< "x:y:z"; echo "$a|$b|$c"');
  expect(h.out.trim()).toBe('x|y|z');
});

test('while IFS=, read -r parses CSV lines', async () => {
  const h = mk();
  await h.ex.exec('while IFS=, read -r f1 f2; do echo "$f1/$f2"; done <<< $\'a,b\\nc,d\'');
  expect(h.out.trim().split('\n')).toEqual(['a/b', 'c/d']);
});

test('IFS=, read -a splits into the array', async () => {
  const h = mk();
  await h.ex.exec('IFS=, read -a arr <<< "p,q,r"; echo "${arr[0]}-${arr[1]}-${arr[2]}"');
  expect(h.out.trim()).toBe('p-q-r');
});

test('read last var absorbs the remainder verbatim (with the separators)', async () => {
  const h = mk();
  await h.ex.exec('IFS=: read a b <<< "x:y:z:w"; echo "$a|$b"');
  expect(h.out.trim()).toBe('x|y:z:w');
});

test('read with a leading IFS delimiter leaves the first field empty', async () => {
  const h = mk();
  await h.ex.exec('IFS=: read x y <<< ":a:b"; echo "[$x][$y]"');
  expect(h.out.trim()).toBe('[][a:b]');
});

test('a command-prefix assignment does not clobber the vars read sets', async () => {
  const h = mk();
  // IFS is a per-command overlay (restored after), but a/b/c persist.
  await h.ex.exec('IFS=: read a b c <<< "x:y:z"; echo "[$IFS]"; echo "$a$b$c"');
  expect(h.out.trim().split('\n')).toEqual(['[]', 'xyz']);
});
