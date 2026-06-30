/* eslint-disable @typescript-eslint/no-explicit-any -- posix tests use a minimal mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function harness(ctx: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const spawned: any[] = [];
  const k = {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; },
    onStderr: (s) => { err += s; },
    resolve: (n) => n,
    ...opts,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

function runPosix(s: string, opts: Record<string, unknown> = {}) {
  const h = harness({}, opts);
  h.ex.setOption('posix', true);
  return { promise: h.ex.exec(s), h };
}

/**
 * A minimal FsClient stub whose `fsStat` reports a fixed set of paths as existing
 * regular files. Used to make `set -C` (noclobber) deterministically throw a
 * RedirectError for `> EXISTING` without a real VFS.
 */
function noclobberFs(existing: Set<string>) {
  return {
    fsOpen: () => 1,
    fsWrite: () => {},
    fsRead: () => '',
    fsClose: () => {},
    fsStat: (p: string) => (existing.has(p) ? { dir: false } : undefined),
  };
}

// ── POSIX: disabled bash extensions ─────────────────────────────────────────

test('brace expansion disabled in POSIX mode', async () => {
  const { promise, h } = runPosix('echo {a,b,c}');
  await promise;
  expect(h.out.trim()).toBe('{a,b,c}');
});

test('echo -n treated as literal in POSIX mode', async () => {
  const { promise, h } = runPosix('echo -n hello');
  await promise;
  expect(h.out.trim()).toBe('-n hello');
});

test('echo -e treated as literal in POSIX mode', async () => {
  const { promise, h } = runPosix('echo -e hi');
  await promise;
  expect(h.out.trim()).toBe('-e hi');
});

test('[[ ]] rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('[[ 1 == 1 ]]');
  const code = await promise;
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/not supported in POSIX mode/);
});

test('(( )) rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('(( 1 + 1 ))');
  const code = await promise;
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/not supported in POSIX mode/);
});

test('<<< here-string rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('cat <<< hello');
  const code = await promise;
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/not supported in POSIX mode/);
});

test('array assignment rejected in POSIX mode', async () => {
  const { promise } = runPosix('arr=(1 2 3)');
  const code = await promise;
  expect(code).not.toBe(0);
});

test('select rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('select x in a b; do break; done');
  const code = await promise;
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/not supported in POSIX mode/);
});

test('declare -A rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('declare -A mymap');
  const code = await promise;
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/not supported in POSIX mode/);
});

test('process substitution <(…) rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('cat <(echo hi)');
  const code = await promise;
  expect(code).not.toBe(0);
  // Assert the full bash-style diagnostic incl. the `syntax error:` prefix, and a
  // single `shell:` prefix (the executor adds it; the message must not carry its own).
  expect(h.err).toMatch(/syntax error:.*process substitution is not supported in POSIX mode/);
  expect(h.err).not.toMatch(/shell: shell:/);
});

test('process substitution >(…) rejected in POSIX mode', async () => {
  const { promise, h } = runPosix('echo hello > >(cat)');
  const code = await promise;
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/syntax error:.*process substitution is not supported in POSIX mode/);
});

// ── POSIX: special-builtin fatality (POSIX 2.8.1) ───────────────────────────

test('POSIX: a bad `set` option is fatal — script aborts', async () => {
  // `set` is a POSIX special builtin; a bad option must abort a non-interactive
  // shell in POSIX mode, so the following echo must NOT run.
  const { promise, h } = runPosix('set -o bogusoption; echo SHOULD_NOT_PRINT');
  const code = await promise;
  expect(h.out).not.toContain('SHOULD_NOT_PRINT');
  expect(code).toBe(2); // PosixSpecialBuiltinError('set', 2, …) → exiting=2
  // The diagnostic reaches stderr with a SINGLE `shell:` prefix (not doubled).
  expect(h.err).toMatch(/invalid option name/);
  expect(h.err).not.toMatch(/shell: shell:/);
});

test('non-POSIX: the same bad `set` option is NOT fatal — script continues', async () => {
  const h = harness();
  // default (non-posix) mode: error is reported (status 2), execution continues.
  await h.ex.exec('set -o bogusoption; echo STILL_RUNS');
  expect(h.out).toContain('STILL_RUNS');
});

// POSIX 2.8.1: a REDIRECTION error on a special builtin (`:`, `export`, …) must
// abort a non-interactive shell in posix mode. The harness drives a deterministic
// RedirectError via `set -C` (noclobber) over a stubbed FsClient that reports the
// target as an existing regular file — `: > existing` then refuses to overwrite.
test('POSIX: a redirection error on a special builtin (:) is fatal — script aborts', async () => {
  const fs = noclobberFs(new Set(['/exists']));
  const { promise, h } = runPosix('set -C; : > /exists; echo SHOULD_NOT_PRINT', { fs });
  const code = await promise;
  expect(h.out).not.toContain('SHOULD_NOT_PRINT');
  expect(code).not.toBe(0);
  // The diagnostic reaches stderr with a SINGLE `shell:` prefix (not doubled).
  expect(h.err).toMatch(/cannot overwrite existing file/);
  expect(h.err).not.toMatch(/shell: shell:/);
});

test('POSIX: a redirection error on `export` (special builtin) is fatal', async () => {
  const fs = noclobberFs(new Set(['/exists']));
  const { promise, h } = runPosix('set -C; export X=1 > /exists; echo SHOULD_NOT_PRINT', { fs });
  const code = await promise;
  expect(h.out).not.toContain('SHOULD_NOT_PRINT');
  expect(code).not.toBe(0);
});

test('POSIX: a redirection error on a NON-special builtin (echo) is NOT fatal', async () => {
  // `echo` is a regular builtin, not a POSIX special builtin: a redirect error
  // is non-fatal even in posix mode — the next statement still runs.
  const fs = noclobberFs(new Set(['/exists']));
  const { promise, h } = runPosix('set -C; echo hi > /exists; echo STILL_RUNS', { fs });
  await promise;
  expect(h.out).toContain('STILL_RUNS');
});

test('non-POSIX: the same redirection error on a special builtin is NOT fatal', async () => {
  const fs = noclobberFs(new Set(['/exists']));
  const h = harness({}, { fs });
  await h.ex.exec('set -C; : > /exists; echo STILL_RUNS');
  expect(h.out).toContain('STILL_RUNS');
});

// POSIX 2.8.1: a variable-ASSIGNMENT error in a non-interactive shell is fatal.
// Reassigning a readonly variable must abort the script (the following echo must
// NOT run) with a SINGLE `shell:` prefix on the diagnostic.
test('POSIX: assigning a readonly variable is fatal — script aborts', async () => {
  const { promise, h } = runPosix('readonly RO=1; RO=2; echo SHOULD_NOT_PRINT');
  const code = await promise;
  expect(h.out).not.toContain('SHOULD_NOT_PRINT');
  expect(code).not.toBe(0);
  expect(h.err).toMatch(/RO: readonly variable/);
  expect(h.err).not.toMatch(/shell: shell:/);
});

// ── POSIX: activation methods ────────────────────────────────────────────────

test('set -o posix activates brace-expansion suppression at runtime', async () => {
  let out = '';
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, { onStdout: (s) => { out += s; }, resolve: (n) => n });
  await ex.exec('set -o posix; echo {a,b}');
  expect(out.trim()).toBe('{a,b}');
});

// ── POSIX: features that STILL work ─────────────────────────────────────────

test('basic commands work in POSIX mode', async () => {
  const { promise, h } = runPosix('echo hello');
  await promise;
  expect(h.out.trim()).toBe('hello');
});

test('for loop works in POSIX mode', async () => {
  const { promise, h } = runPosix('for i in a b c; do echo $i; done');
  await promise;
  expect(h.out.trim()).toBe('a\nb\nc');
});

test('test/[ builtin works in POSIX mode', async () => {
  const { promise, h } = runPosix('if [ 1 -eq 1 ]; then echo eq; fi');
  await promise;
  expect(h.out.trim()).toBe('eq');
});

// ── $SHELLOPTS / $BASHOPTS ───────────────────────────────────────────────────

test('set -e; echo $SHELLOPTS includes errexit', async () => {
  let out = '';
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, { onStdout: (s) => { out += s; }, resolve: (n) => n });
  await ex.exec('set -e\necho $SHELLOPTS');
  expect(out.trim().split(':')).toContain('errexit');
});

test('$SHELLOPTS is sorted and colon-separated', async () => {
  let out = '';
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, { onStdout: (s) => { out += s; }, resolve: (n) => n });
  await ex.exec('set -e\nset -o pipefail\necho $SHELLOPTS');
  const opts = out.trim().split(':');
  expect(opts).toEqual([...opts].sort());
  expect(out.trim()).not.toContain(' ');
});

test('shopt -s extglob; echo $BASHOPTS includes extglob', async () => {
  let out = '';
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, { onStdout: (s) => { out += s; }, resolve: (n) => n });
  await ex.exec('shopt -s extglob\necho $BASHOPTS');
  expect(out.trim().split(':')).toContain('extglob');
});
