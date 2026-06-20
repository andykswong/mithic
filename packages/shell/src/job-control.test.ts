/* eslint-disable @typescript-eslint/no-explicit-any -- job-control tests use a minimal mock kernel */
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

// ── $! ───────────────────────────────────────────────────────────────────────

test('$! is empty when no process was backgrounded', async () => {
  const h = mk();
  await h.ex.exec('echo "$!"');
  expect(h.out.trim()).toBe('');
});

// ── wait ─────────────────────────────────────────────────────────────────────

test('wait for nonexistent job returns 127', async () => {
  const h = mk();
  await h.ex.exec('wait %1\necho $?');
  expect(h.out.trim()).toBe('127');
});

test('wait with no jobs returns 0', async () => {
  const h = mk();
  await h.ex.exec('wait\necho $?');
  expect(h.out.trim()).toBe('0');
});

// ── jobs ─────────────────────────────────────────────────────────────────────

test('jobs lists nothing when none exist', async () => {
  const h = mk();
  await h.ex.exec('jobs');
  expect(h.out.trim()).toBe('');
});

// ── kill ─────────────────────────────────────────────────────────────────────

test('kill unknown job returns error', async () => {
  const h = mk();
  await h.ex.exec('kill %99');
  expect(h.err).toContain('no such job');
});

test('kill with no args prints usage', async () => {
  const h = mk();
  await h.ex.exec('kill');
  expect(h.err).toContain('usage');
});

// ── disown ─────────────────────────────────────────────────────────────────────

test('disown unknown job returns error', async () => {
  const h = mk();
  await h.ex.exec('disown %99');
  expect(h.err).toContain('no such job');
});

// ── trap ─────────────────────────────────────────────────────────────────────

test('trap EXIT runs handler on shell exit', async () => {
  const h = mk();
  await h.ex.exec('trap "echo goodbye" EXIT\nexit');
  expect(h.out).toContain('goodbye');
});

test('trap EXIT runs on natural EOF', async () => {
  const h = mk();
  await h.ex.exec('trap "echo bye" EXIT');
  expect(h.out).toContain('bye');
});

test('trap with no args lists traps', async () => {
  const h = mk();
  await h.ex.exec('trap "echo hi" EXIT\ntrap');
  expect(h.out).toContain("'echo hi' EXIT");
});

test('trap - removes all handlers', async () => {
  const h = mk();
  // Re-list after clearing; the EXIT handler must not fire either.
  await h.ex.exec('trap "echo hi" EXIT\ntrap -\ntrap > /dev/null\necho done');
  expect(h.out.trim()).toBe('done');
});

test('trap - SIG removes a specific handler', async () => {
  const h = mk();
  await h.ex.exec('trap "echo a" EXIT\ntrap "echo b" INT\ntrap - EXIT\ntrap');
  expect(h.out).not.toContain("'echo a' EXIT");
  expect(h.out).toContain("'echo b' INT");
});

test('trap accepts signal numbers (2 -> INT)', async () => {
  const h = mk();
  await h.ex.exec('trap "echo caught" 2\ntrap');
  expect(h.out).toContain("'echo caught' INT");
});

test('trap ERR fires on a failed command', async () => {
  const h = mk();
  await h.ex.exec('trap "echo err_fired" ERR\nfalse');
  expect(h.out).toContain('err_fired');
});

// ── history ─────────────────────────────────────────────────────────────────

test('history lists previous commands with numbers', async () => {
  const h = mk();
  await h.ex.exec('echo first\necho second\nhistory');
  expect(h.out).toContain('echo first');
  expect(h.out).toContain('echo second');
  expect(h.out).toMatch(/\d+\s+echo first/);
});

test('history -c clears history', async () => {
  const h = mk();
  await h.ex.exec('echo a\nhistory -c\nhistory');
  expect(h.out).not.toContain('echo a');
});

test('fc -l lists recent commands', async () => {
  const h = mk();
  await h.ex.exec('echo first\necho second\nfc -l');
  expect(h.out).toContain('echo first');
  expect(h.out).toContain('echo second');
});

test('HISTSIZE limits history length', async () => {
  const h = mk({ env: { HISTSIZE: '3' } });
  await h.ex.exec('echo a\necho b\necho c\necho d\necho e\nhistory');
  // Only the last 3 commands before history remain.
  expect(h.out).not.toContain('echo a');
  expect(h.out).toContain('echo e');
});
