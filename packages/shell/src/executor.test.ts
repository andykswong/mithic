/* eslint-disable @typescript-eslint/no-explicit-any -- executor tests use a minimal mock kernel typed as any */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import { parse } from './parser.ts';

function mockKernel() {
  const spawned: any[] = [];
  return {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async pipe() { return { readfd: 100, writefd: 101 }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
}

/** In-memory VFS for redirect tests. Maps path → file contents (as string). */
function mockFs() {
  const files = new Map<string, string>();
  let nextFd = 10;
  // Map fd → { path, mode, pos }
  const openFiles = new Map<number, { path: string; mode: 'w' | 'a' | 'r'; buf: string }>();

  return {
    files,
    fsOpen(path: string, flags: { read?: boolean; write?: boolean; append?: boolean; create?: boolean; truncate?: boolean }): number {
      const fd = nextFd++;
      let buf = '';
      if (flags.append && files.has(path)) buf = files.get(path)!;
      const mode = flags.read ? 'r' : flags.append ? 'a' : 'w';
      openFiles.set(fd, { path, mode, buf });
      return fd;
    },
    fsWrite(fd: number, data: string): void {
      const entry = openFiles.get(fd);
      if (!entry) throw new Error(`bad fd ${fd}`);
      entry.buf += data;
    },
    fsRead(fd: number): string {
      const entry = openFiles.get(fd);
      if (!entry) throw new Error(`bad fd ${fd}`);
      return files.get(entry.path) ?? '';
    },
    fsClose(fd: number): void {
      const entry = openFiles.get(fd);
      if (!entry) return;
      if (entry.mode !== 'r') files.set(entry.path, entry.buf);
      openFiles.delete(fd);
    },
    fsReaddir(path: string): string[] {
      const prefix = path === '/' ? '/' : path.replace(/\/$/, '') + '/';
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash >= 0 ? rest.slice(0, slash) : rest);
        }
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

// ── Existing tests ─────────────────────────────────────────────────────────

test('a pipeline spawns one child per stage and wires pipes', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} });
  const code = await ex.run(parse('alpha | beta | gamma'));
  expect(k.spawned).toHaveLength(3);
  expect(code).toBe(0);
});

test('builtin runs in-process without spawning', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} });
  await ex.run(parse('cd /tmp'));
  expect(k.spawned).toHaveLength(0);
  expect(ex.context.cwd).toBe('/tmp');
});

// ── Fix 1: prefix-assignment visible to its own command's expansion ─────────

test('FOO=bar echo $FOO prints bar (prefix-assignment visible to command expansion)', async () => {
  const k = mockKernel();
  let captured = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { captured += s; },
  });
  const code = await ex.run(parse('FOO=bar echo $FOO'));
  expect(code).toBe(0);
  expect(captured.trim()).toBe('bar');
});

test('bare FOO=bar assignment persists to context.env', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} });
  await ex.run(parse('FOO=bar'));
  expect(ex.context.env['FOO']).toBe('bar');
});

test('prefix-assignment does NOT leak into context.env after command exits', async () => {
  const k = mockKernel();
  let captured = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { captured += s; },
  });
  await ex.run(parse('FOO=bar echo $FOO'));
  // FOO must not be in the env after the command exits
  expect(ex.context.env['FOO']).toBeUndefined();
  // but the echo itself saw it
  expect(captured.trim()).toBe('bar');
});

// ── Fix 2: redirect execution (>/>> write to VFS) ──────────────────────────

test('echo hello > /tmp/out.txt writes to file not stdout (truncate)', async () => {
  const k = mockKernel();
  const fs = mockFs();
  let capturedStdout = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { capturedStdout += s; },
    fs,
  });
  const code = await ex.run(parse('echo hello > /tmp/out.txt'));
  expect(code).toBe(0);
  // Nothing on stdout — it went to the file.
  expect(capturedStdout).toBe('');
  // The file has the data.
  expect(fs.files.get('/tmp/out.txt')).toBe('hello\n');
});

test('echo world >> /tmp/out.txt appends to existing file', async () => {
  const k = mockKernel();
  const fs = mockFs();
  fs.files.set('/tmp/out.txt', 'hello\n'); // pre-existing content
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    fs,
  });
  const code = await ex.run(parse('echo world >> /tmp/out.txt'));
  expect(code).toBe(0);
  expect(fs.files.get('/tmp/out.txt')).toBe('hello\nworld\n');
});

test('< input redirect feeds file into command stdin', async () => {
  const k = mockKernel();
  const fs = mockFs();
  fs.files.set('/tmp/in.txt', 'data\n');
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, { fs, onStdout: (s) => { out += s; } });
  const code = await ex.run(parse('cat < /tmp/in.txt'));
  expect(code).toBe(0);
  expect(out).toBe('data\n');
});

test('redirect target path is expanded from env', async () => {
  const k = mockKernel();
  const fs = mockFs();
  const ex = new Executor(k as any, { cwd: '/', env: { OUTFILE: '/tmp/env-out.txt' } }, { fs });
  await ex.run(parse('echo hi > $OUTFILE'));
  expect(fs.files.get('/tmp/env-out.txt')).toBe('hi\n');
});

// ── Fix: stdin redirect / here-string into an EXTERNAL command wires stdinData ──

test('< file into an external command passes file contents as spawn stdinData', async () => {
  const k = mockKernel();
  const fs = mockFs();
  fs.files.set('/tmp/in.txt', 'line1\nline2\n');
  // `grepx` is external (not a builtin) so it spawns; the redirect must arrive
  // as stdinData on the spawn params (otherwise the child would block on stdin).
  const ex = new Executor(k as any, { cwd: '/', env: {} }, { fs, resolve: (n) => n });
  await ex.run(parse('grepx < /tmp/in.txt'));
  expect(k.spawned).toHaveLength(1);
  expect(k.spawned[0].stdinData).toBe('line1\nline2\n');
});

test('<<< here-string into an external command passes the word + newline as stdinData', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} }, { resolve: (n) => n });
  await ex.run(parse('grepx <<< "data here"'));
  expect(k.spawned).toHaveLength(1);
  expect(k.spawned[0].stdinData).toBe('data here\n');
});

test('<< heredoc into an external command passes the body as stdinData', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: { U: 'bob' } }, { resolve: (n) => n });
  await ex.run(parse('grepx <<EOF\nhello $U\nEOF'));
  expect(k.spawned).toHaveLength(1);
  expect(k.spawned[0].stdinData).toBe('hello bob\n');
});

// ── SH-1: argument forwarding via "$@" preserves field count ────────────────

test('f "$@" forwards each positional as a separate argument ($# = 3)', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, positional: ['a', 'b c', 'd'] }, {
    onStdout: (s) => { out += s; },
  });
  const code = await ex.run(parse('f() { echo $#; }; f "$@"'));
  expect(code).toBe(0);
  expect(out.trim()).toBe('3');
});

test('f "$@" inside the callee sees the spaced arg intact ($2 = "b c")', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, positional: ['a', 'b c', 'd'] }, {
    onStdout: (s) => { out += s; },
  });
  const code = await ex.run(parse('f() { echo "$2"; }; f "$@"'));
  expect(code).toBe(0);
  expect(out.trim()).toBe('b c');
});

test('for x in "$@" iterates once per positional', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, positional: ['a', 'b c', 'd'] }, {
    onStdout: (s) => { out += s; },
  });
  const code = await ex.run(parse('for x in "$@"; do echo "[$x]"; done'));
  expect(code).toBe(0);
  expect(out).toBe('[a]\n[b c]\n[d]\n');
});

test('set -- a b c; echo ${#@} reports positional count (SH-2)', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { out += s; },
  });
  const code = await ex.run(parse('set -- a b c; echo ${#@}'));
  expect(code).toBe(0);
  expect(out.trim()).toBe('3');
});

test('set -- a b c; echo ${#*} reports positional count (SH-2)', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { out += s; },
  });
  const code = await ex.run(parse('set -- a b c; echo ${#*}'));
  expect(code).toBe(0);
  expect(out.trim()).toBe('3');
});

