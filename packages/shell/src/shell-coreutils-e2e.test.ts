/**
 * THE end-to-end integration proof: the REAL `@mithic/shell` process driving the
 * REAL coreutils / jq / curl commands through the REAL kernel's
 * `process/pipeline` + `process/spawn` syscalls.
 *
 * Unlike `shell-e2e.test.ts` (which registers tiny inline guest programs), this
 * boots a Kernel whose `resolveCommand` is the COMPOSED production resolver from
 * `@mithic/coreutils` + `@mithic/jq` + `@mithic/curl`, mounts a MemoryFs, and
 * spawns the built `@mithic/shell` `dist/process.js`. Real shell scripts then run
 * real coreutils end-to-end. This is the first test that proves the three phases
 * (process/spawn, shell interpreter, command suite) actually compose.
 *
 * REQUIRES all packages built: `npm run build` (so each command's dist module and
 * the shell's `dist/process.js` exist for the resolver/launcher to import).
 *
 * The shell is granted BOTH a `process` cap (to fork children) and read+write fs
 * caps over `/` — children narrow these from the shell, so spawned coreutils that
 * touch the VFS (e.g. `sort file`, `cat *.txt`) inherit fs access.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';
import { createJqResolver } from '@mithic/jq';
import { createCurlResolver } from '@mithic/curl';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

/**
 * Compose the three production resolvers into one `resolveCommand`. Each returns
 * a `file://` URL to its built `dist` guest module, or `undefined` to defer.
 */
function composedResolver(): (name: string, cwd: string, env: Record<string, string>) => string | URL | undefined {
  const coreutils = createCoreutilsResolver();
  const jq = createJqResolver();
  const curl = createCurlResolver();
  return (name, cwd, env) => coreutils(name, cwd, env) ?? jq(name, cwd, env) ?? curl(name, cwd, env);
}

/** Boot a real Kernel + WorkerRuntime with the composed resolver and a seeded MemoryFs. */
async function bootShell(files: Record<string, string> = {}): Promise<{
  run: (script: string) => Promise<{ stdout: string; code: number }>;
  readFile: (path: string) => Promise<string>;
}> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const fs = new MemoryFsProvider({ files });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: composedResolver() });
  const guestUrl = new URL('../dist/process.js', import.meta.url);

  return {
    async run(script) {
      const { pid, stdout } = await kernel.spawn(guestUrl, {
        args: ['shell', script],
        capabilities: [{ type: 'process' }, ...FS_RW],
        captureStdout: true,
      });
      const { code } = await kernel.wait(pid);
      const bytes = stdout ? await stdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), code };
    },
    async readFile(path) {
      const h = await fs.open(path, { read: true });
      const chunks: Uint8Array[] = [];
      let off = 0;
      for (;;) {
        const c = await fs.read(h, off, 65536);
        if (!c || c.byteLength === 0) break;
        chunks.push(new Uint8Array(c));
        off += c.byteLength;
      }
      await fs.close(h);
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const buf = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
      return new TextDecoder().decode(buf);
    },
  };
}

const T = 30000;

test('builtin echo | external grep → matched line', async () => {
  const k = await bootShell();
  const out = await k.run('echo hello | grep ell');
  expect(out.stdout).toBe('hello\n');
  expect(out.code).toBe(0);
}, T);

test('printf | external sort → sorted lines', async () => {
  const k = await bootShell();
  const out = await k.run('printf \'c\\nb\\na\\n\' | sort');
  expect(out.stdout).toBe('a\nb\nc\n');
  expect(out.code).toBe(0);
}, T);

test('sort file | uniq -c → counted unique lines', async () => {
  const k = await bootShell({ '/in.txt': 'a\nb\na\n' });
  const out = await k.run('sort /in.txt | uniq -c');
  // uniq -c prefixes a count; GNU pads with leading spaces.
  const lines = out.stdout.trimEnd().split('\n').map((l) => l.trim());
  expect(lines).toEqual(['2 a', '1 b']);
  expect(out.code).toBe(0);
}, T);

test('seq 1 5 | wc -l → 5', async () => {
  const k = await bootShell();
  const out = await k.run('seq 1 5 | wc -l');
  expect(out.stdout.trim()).toBe('5');
  expect(out.code).toBe(0);
}, T);

test('echo JSON | jq .a → 1', async () => {
  const k = await bootShell();
  const out = await k.run('echo \'{"a":1}\' | jq \'.a\'');
  expect(out.stdout.trim()).toBe('1');
  expect(out.code).toBe(0);
}, T);

test('glob: *.txt expands against the VFS (sort *.txt reads matches)', async () => {
  // `sort` is external, so it reads each globbed file through its own fs caps —
  // this proves pathname expansion (glob) lists the VFS AND that the spawned
  // command receives the expanded operands and reads them. (Glob expansion goes
  // through the shell's `fs/readdir`; this regresses the FsClient readdir-shape
  // bug that made every glob fall back to the literal pattern.)
  const k = await bootShell({ '/a.txt': 'AAA\n', '/b.txt': 'BBB\n', '/c.md': 'CCC\n' });
  const out = await k.run('cd / && sort *.txt');
  expect(out.stdout).toBe('AAA\nBBB\n');
  expect(out.code).toBe(0);
}, T);

test('glob: ls *.txt lists matching files', async () => {
  const k = await bootShell({ '/x.txt': '1', '/y.txt': '2', '/z.log': '3' });
  const out = await k.run('cd / && ls *.txt');
  const names = out.stdout.trim().split(/\s+/).sort();
  expect(names).toEqual(['x.txt', 'y.txt']);
  expect(out.code).toBe(0);
}, T);

test('redirect: echo hi > file, then read it back with an external command', async () => {
  // `/tmp` must exist — the shell's redirect open does NOT create parent dirs
  // (matching POSIX: redirecting into a missing directory fails).
  const k = await bootShell({ '/tmp/.keep': '' });
  const out = await k.run('echo hi > /tmp/x.txt; sort /tmp/x.txt');
  expect(out.stdout).toBe('hi\n');
  expect(out.code).toBe(0);
  expect(await k.readFile('/tmp/x.txt')).toBe('hi\n');
}, T);

test('command substitution drives a real pipeline (unquoted strips padding)', async () => {
  const k = await bootShell();
  // `wc -l` over a pipe emits a space-padded count. UNQUOTED command
  // substitution is word-split on IFS, collapsing the padding to a bare number.
  const out = await k.run('echo count: $(seq 1 3 | wc -l)');
  expect(out.stdout.trim()).toBe('count: 3');
  expect(out.code).toBe(0);
}, T);

test('command substitution inside double quotes preserves wc padding', async () => {
  const k = await bootShell();
  // Inside double quotes, substitution output is NOT word-split, so `wc -l`'s
  // leading padding is preserved verbatim (correct POSIX behavior).
  const out = await k.run('echo "count:$(seq 1 3 | wc -l)"');
  expect(out.stdout).toMatch(/^count:\s+3\n$/);
  expect(out.code).toBe(0);
}, T);

test('multi-stage pipe: producer | grep x | sort | head -n 2', async () => {
  // Five external stages? No — first stage is a producer reading the file. Use
  // `sort file` as the producer (external, reads the VFS), then pipe.
  const k = await bootShell({ '/data.txt': 'xray\nbanana\nxenon\napple\nxalt\n' });
  const out = await k.run('sort /data.txt | grep x | head -n 2');
  expect(out.stdout).toBe('xalt\nxenon\n');
  expect(out.code).toBe(0);
}, T);

// KNOWN GAP — see report. A single EXTERNAL command fed by a `<` redirect (or
// here-string) hangs: the shell's `makeKernelClient.spawn` issues a one-stage
// `process/pipeline` and never delivers `params.stdinData` to the child, so the
// child blocks on stdin forever. Pipelines work (inter-stage pipes); only
// stdin-from-redirect into a lone external is broken. Marked `fails` so the
// suite stays green AND flips red the moment it's fixed (then drop `.fails`).
test.fails('KNOWN GAP: input redirect into a lone external (grep < file) — stdinData dropped', async () => {
  const k = await bootShell({ '/log.txt': 'foo\nbar\nfoobar\n' });
  const out = await k.run('grep foo < /log.txt');
  expect(out.stdout).toBe('foo\nfoobar\n');
  expect(out.code).toBe(0);
}, 8000);

// KNOWN GAP — see report. `cat` is a shell BUILTIN that only echoes stdin; it
// ignores file operands entirely (`builtins.ts` `case 'cat'`). So `cat <file>`
// and `cat *.txt` print nothing even though the external coreutils `cat` would
// read them. Marked `fails` to document + guard the gap.
test.fails('KNOWN GAP: builtin cat ignores file operands (cat <file> reads nothing)', async () => {
  const k = await bootShell({ '/a.txt': 'AAA\n' });
  const out = await k.run('cat /a.txt');
  expect(out.stdout).toBe('AAA\n');
}, T);

test('exit code: grep with no match returns 1', async () => {
  const k = await bootShell();
  const out = await k.run('echo hello | grep zzz; echo "rc=$?"');
  expect(out.stdout.trim()).toBe('rc=1');
}, T);

test('exit code: command-not-found surfaces nonzero', async () => {
  const k = await bootShell();
  const out = await k.run('definitely-not-a-real-command; echo "rc=$?"');
  expect(out.stdout.trim()).toContain('rc=');
  expect(out.stdout.trim()).not.toBe('rc=0');
}, T);

test('tr translation through a pipe', async () => {
  const k = await bootShell();
  const out = await k.run('echo hello | tr a-z A-Z');
  expect(out.stdout.trim()).toBe('HELLO');
  expect(out.code).toBe(0);
}, T);
