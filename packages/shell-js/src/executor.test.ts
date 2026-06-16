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

test('< input redirect raises explicit unsupported-redirect error', async () => {
  const k = mockKernel();
  const fs = mockFs();
  fs.files.set('/tmp/in.txt', 'data\n');
  const ex = new Executor(k as any, { cwd: '/', env: {} }, { fs });
  await expect(ex.run(parse('cat < /tmp/in.txt'))).rejects.toThrow(/unsupported redirect/i);
});

test('redirect target path is expanded from env', async () => {
  const k = mockKernel();
  const fs = mockFs();
  const ex = new Executor(k as any, { cwd: '/', env: { OUTFILE: '/tmp/env-out.txt' } }, { fs });
  await ex.run(parse('echo hi > $OUTFILE'));
  expect(fs.files.get('/tmp/env-out.txt')).toBe('hi\n');
});
