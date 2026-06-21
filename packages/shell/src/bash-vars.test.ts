/* eslint-disable @typescript-eslint/no-explicit-any -- bash-var tests use a minimal mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mk(ctx: Record<string, unknown> = {}) {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

// ── $RANDOM ──────────────────────────────────────────────────────────────────

test('$RANDOM yields integers in 0..32767', async () => {
  const h = mk();
  await h.ex.exec('for i in 1 2 3 4 5; do echo $RANDOM; done');
  const nums = h.out.trim().split('\n').map((s) => parseInt(s, 10));
  expect(nums).toHaveLength(5);
  for (const n of nums) {
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(32767);
  }
});

test('$RANDOM changes between reads', async () => {
  const h = mk();
  await h.ex.exec('a=$RANDOM; b=$RANDOM; c=$RANDOM; echo "$a $b $c"');
  const [a, b, c] = h.out.trim().split(' ');
  // Extremely unlikely all three coincide for a non-degenerate generator.
  expect(a === b && b === c).toBe(false);
});

test('seeding $RANDOM by assignment makes the sequence reproducible', async () => {
  const h1 = mk();
  await h1.ex.exec('RANDOM=42; echo $RANDOM; echo $RANDOM');
  const h2 = mk();
  await h2.ex.exec('RANDOM=42; echo $RANDOM; echo $RANDOM');
  expect(h1.out.trim()).toBe(h2.out.trim());
});

// ── $SHLVL ───────────────────────────────────────────────────────────────────

test('$SHLVL is 1 when not inherited', async () => {
  const h = mk();
  await h.ex.exec('echo $SHLVL');
  expect(h.out.trim()).toBe('1');
});

test('$SHLVL increments an inherited value', async () => {
  const h = mk({ env: { SHLVL: '2' } });
  await h.ex.exec('echo $SHLVL');
  expect(h.out.trim()).toBe('3');
});

test('$SHLVL resets to 1 for absurd inherited values', async () => {
  const hi = mk({ env: { SHLVL: '5000' } });
  await hi.ex.exec('echo $SHLVL');
  expect(hi.out.trim()).toBe('1');
  const neg = mk({ env: { SHLVL: '-3' } });
  await neg.ex.exec('echo $SHLVL');
  expect(neg.out.trim()).toBe('1');
});

// ── $BASH_VERSION / $BASH_VERSINFO ───────────────────────────────────────────

test('$BASH_VERSION is a sensible version string', async () => {
  const h = mk();
  await h.ex.exec('echo $BASH_VERSION');
  expect(h.out.trim()).toMatch(/^5\.3\.0\(1\)-release$/);
});

test('bare $BASH_VERSINFO is the major version', async () => {
  const h = mk();
  await h.ex.exec('echo $BASH_VERSINFO');
  expect(h.out.trim()).toBe('5');
});

test('$BASH_VERSINFO is indexable as an array', async () => {
  const h = mk();
  await h.ex.exec('echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}.${BASH_VERSINFO[2]}"');
  expect(h.out.trim()).toBe('5.3.0');
});

test('$BASH_VERSINFO[4] is the release status', async () => {
  const h = mk();
  await h.ex.exec('echo "${BASH_VERSINFO[4]}"');
  expect(h.out.trim()).toBe('release');
});

// ── A3: TMOUT idle-exit is Tier 2 (inert); `read -t` on string stdin is Tier 1 ──
//
// `read -u N -t T` over a LIVE duplex fd now honors the timeout (see
// `read-timeout.test.ts`). The TMOUT *idle-timeout-exit* and a blocking `read
// -t` over the pre-materialized stdin STRING are Tier 2 (need a live
// ReadableStream-backed stdin + the interactive REPL loop), still deferred.

test('TMOUT is accepted as an ordinary variable and does not trigger an idle exit', async () => {
  const h = mk();
  // Assigning TMOUT does not error, the value reads back, and subsequent
  // commands run normally — TMOUT's interactive idle-timeout exit is Tier 2.
  await h.ex.exec('TMOUT=1\necho "tmout=$TMOUT"\nsleep_placeholder=ok\necho done');
  expect(h.out).toContain('tmout=1');
  expect(h.out).toContain('done');
});

test('read -t on string stdin returns immediately (Tier 1: data already materialized)', async () => {
  const h = mk();
  // stdin is a pre-materialized string, so `read -t` can never block: it reads
  // the available line right away and succeeds (the timer never fires).
  await h.ex.exec('printf "hello\\n" | { read -t 1 x; echo "rc=$? x=$x"; }');
  expect(h.out.trim()).toBe('rc=0 x=hello');
});
