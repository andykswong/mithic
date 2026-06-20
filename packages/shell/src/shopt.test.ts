/* eslint-disable @typescript-eslint/no-explicit-any -- shopt tests use a minimal mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mk() {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

test('shopt with no args lists options', async () => {
  const h = mk();
  await h.ex.exec('shopt');
  expect(h.out).toContain('extglob');
  expect(h.out).toContain('globstar');
  expect(h.out).toContain('nullglob');
  expect(h.out).toContain('dotglob');
});

test('shopt -s extglob enables extglob', async () => {
  const h = mk();
  const code = await h.ex.exec('shopt -s extglob\nshopt extglob');
  expect(code).toBe(0);
  expect(h.out).toContain('on');
});

test('shopt -u extglob disables it (exit 1, shows off)', async () => {
  const h = mk();
  const code = await h.ex.exec('shopt -s extglob\nshopt -u extglob\nshopt extglob');
  expect(code).toBe(1);
  expect(h.out).toContain('off');
});

test('shopt -q extglob returns exit code without output', async () => {
  const h = mk();
  const code = await h.ex.exec('shopt -s extglob\nshopt -q extglob');
  expect(code).toBe(0);
  expect(h.out).toBe('');
});

test('shopt -q returns 1 for disabled option', async () => {
  const h = mk();
  const code = await h.ex.exec('shopt -q extglob');
  expect(code).toBe(1);
  expect(h.out).toBe('');
});

test('shopt -p extglob prints reusable format', async () => {
  const h = mk();
  await h.ex.exec('shopt -s extglob\nshopt -p extglob');
  expect(h.out.trim()).toBe('shopt -s extglob');
});

test('shopt -s invalid_option errors to stderr and exits 2', async () => {
  const h = mk();
  await h.ex.exec('shopt -s invalid_option\necho exit=$?');
  expect(h.err).toContain('invalid_option');
  expect(h.out).toContain('exit=2');
});

test('shopt -s opt1 opt2 enables multiple', async () => {
  const h = mk();
  const code = await h.ex.exec('shopt -s extglob globstar\nshopt -q extglob\nA=$?\nshopt -q globstar\nB=$?\necho $A$B');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('00');
});

test('shopt -u globstar after -s; shopt -q reflects state', async () => {
  const h = mk();
  await h.ex.exec('shopt -s globstar\nshopt -u globstar\nshopt -q globstar\necho $?');
  expect(h.out.trim()).toBe('1');
});
