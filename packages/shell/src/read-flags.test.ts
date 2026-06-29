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
