/* eslint-disable @typescript-eslint/no-explicit-any -- extglob integration tests use a mock kernel + fs */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mockFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
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
    fsReaddir(path: string): string[] {
      const prefix = path === '/' ? '/' : path.replace(/\/$/, '') + '/';
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) { const rest = p.slice(prefix.length); const slash = rest.indexOf('/'); names.add(slash >= 0 ? rest.slice(0, slash) : rest); }
      }
      return [...names];
    },
    fsStat(path: string): { dir: boolean } | undefined {
      if (files.has(path)) return { dir: false };
      const prefix = path.replace(/\/$/, '') + '/';
      for (const p of files.keys()) if (p.startsWith(prefix)) return { dir: true };
      return undefined;
    },
  };
}

function mk(fs = mockFs(), ctx: Record<string, unknown> = {}) {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n, fs,
  });
  return { ex, fs, get out() { return out; }, get err() { return err; } };
}

// ── extglob in case (M7) ─────────────────────────────────────────────────────

test('shopt -s extglob enables @() in case', async () => {
  const h = mk();
  await h.ex.exec('shopt -s extglob\nx=foo\ncase "$x" in @(foo|bar)) echo matched;; *) echo nomatch;; esac');
  expect(h.out.trim()).toBe('matched');
});

test('extglob disabled by default - @() literal in case', async () => {
  const h = mk();
  await h.ex.exec('x=foo\ncase "$x" in @(foo|bar)) echo matched;; *) echo nomatch;; esac');
  expect(h.out.trim()).toBe('nomatch');
});

test('extglob @() in [[ ]]', async () => {
  const h = mk();
  await h.ex.exec('shopt -s extglob\n[[ file.txt == @(*.txt|*.rs) ]] && echo matched || echo nomatch');
  expect(h.out.trim()).toBe('matched');
});

test('extglob !(foo|bar) negation in [[ ]]', async () => {
  const h = mk();
  await h.ex.exec('shopt -s extglob\nfor x in foo bar baz; do [[ "$x" == !(foo|bar) ]] && echo "Y $x" || echo "N $x"; done');
  expect(h.out.trim()).toBe('N foo\nN bar\nY baz');
});

test('extglob in ${var#@(foo|bar)}', async () => {
  const h = mk();
  await h.ex.exec('shopt -s extglob\nx=foobarfoo\necho "${x#@(foo|bar)}"');
  expect(h.out.trim()).toBe('barfoo');
});

// ── POSIX classes in case ─────────────────────────────────────────────────────

test('[[:digit:]] in case pattern', async () => {
  const h = mk();
  await h.ex.exec('x=5\ncase "$x" in [[:digit:]]) echo digit;; *) echo other;; esac');
  expect(h.out.trim()).toBe('digit');
});

// ── globstar + dotglob + nullglob (pathname) ─────────────────────────────────

test('shopt -s globstar enables ** recursive matching', async () => {
  const fs = mockFs({ '/g/a.txt': '', '/g/sub/b.txt': '', '/g/sub/deep/c.txt': '' });
  const h = mk(fs, { cwd: '/g' });
  await h.ex.exec('shopt -s globstar\necho **/*.txt');
  const out = h.out.trim();
  expect(out).toContain('a.txt');
  expect(out).toContain('sub/b.txt');
  expect(out).toContain('sub/deep/c.txt');
});

test('globstar disabled by default - ** is single-level', async () => {
  const fs = mockFs({ '/g2/a.txt': '', '/g2/sub/b.txt': '' });
  const h = mk(fs, { cwd: '/g2' });
  await h.ex.exec('echo **');
  // Without globstar, ** behaves like * (single segment): does not include sub/b.txt
  expect(h.out).not.toContain('sub/b.txt');
});

test('nullglob makes a non-matching pattern expand to nothing', async () => {
  const fs = mockFs({ '/n/a.txt': '' });
  const h = mk(fs, { cwd: '/n' });
  await h.ex.exec('shopt -s nullglob\necho before *.nomatch after');
  expect(h.out.trim()).toBe('before after');
});

test('without nullglob a non-matching pattern stays literal', async () => {
  const fs = mockFs({ '/n2/a.txt': '' });
  const h = mk(fs, { cwd: '/n2' });
  await h.ex.exec('echo *.nomatch');
  expect(h.out.trim()).toBe('*.nomatch');
});

test('dotglob includes dotfiles', async () => {
  const fs = mockFs({ '/d/.hidden': '', '/d/visible': '' });
  const h = mk(fs, { cwd: '/d' });
  await h.ex.exec('shopt -s dotglob\necho *');
  expect(h.out).toContain('.hidden');
});

test('without dotglob, * hides dotfiles', async () => {
  const fs = mockFs({ '/d2/.hidden': '', '/d2/visible': '' });
  const h = mk(fs, { cwd: '/d2' });
  await h.ex.exec('echo *');
  expect(h.out).not.toContain('.hidden');
  expect(h.out).toContain('visible');
});
