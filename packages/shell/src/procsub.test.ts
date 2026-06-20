/* eslint-disable @typescript-eslint/no-explicit-any -- procsub tests use a mock kernel + fs */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mockFs() {
  const files = new Map<string, string>();
  let nextFd = 10;
  const open = new Map<number, { path: string; mode: string; buf: string }>();
  return {
    files,
    fsOpen(path: string, flags: any): number {
      const fd = nextFd++; let buf = '';
      if (flags.append && files.has(path)) buf = files.get(path)!;
      const mode = flags.read ? 'r' : flags.append ? 'a' : 'w';
      if (mode === 'w' && !files.has(path)) files.set(path, '');
      open.set(fd, { path, mode, buf }); return fd;
    },
    fsWrite(fd: number, d: string): void { open.get(fd)!.buf += d; },
    fsRead(fd: number): string { const e = open.get(fd)!; if (!files.has(e.path)) throw new Error('nf'); return files.get(e.path) ?? ''; },
    fsClose(fd: number): void { const e = open.get(fd); if (!e) return; if (e.mode !== 'r') files.set(e.path, e.buf); open.delete(fd); },
    fsStat(path: string): { dir: boolean } | undefined { return files.has(path) ? { dir: false } : undefined; },
  };
}

function mk(fs = mockFs()) {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n, fs,
  });
  return { ex, fs, get out() { return out; }, get err() { return err; } };
}

// ── M4: process substitution <(cmd) ──────────────────────────────────────────

test('<(cmd) substitutes a readable path containing the command output', async () => {
  const h = mk();
  // `cat <(echo hi)` — the inner echo's output becomes the file `cat` reads.
  await h.ex.exec('cat < <(echo hi)');
  expect(h.out.trim()).toBe('hi');
});

test('reading the <(cmd) path via $(< ...) yields the command output', async () => {
  const h = mk();
  await h.ex.exec('p=<(printf "a\\nb\\n")\necho "$(< $p)"');
  expect(h.out.trim()).toBe('a\nb');
});

// ── M4: process substitution >(cmd) ──────────────────────────────────────────

test('>(cmd) substitutes a writable path the command consumes', async () => {
  const h = mk();
  // Writing to >(cat) routes the bytes into cat, which echoes to stdout.
  await h.ex.exec('echo hello > >(cat)');
  expect(h.out.trim()).toBe('hello');
});
