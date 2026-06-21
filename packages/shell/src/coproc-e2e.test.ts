/**
 * A2 — coproc round-trip E2E.
 *
 * `coproc NAME command` starts `command` as a BACKGROUND child wired to a
 * bidirectional pipe pair: the shell writes the child's stdin via `${NAME[1]}`
 * and reads the child's stdout via `${NAME[0]}`. `NAME_PID` is the real child
 * pid. This proves the whole coproc data path over the live-stream spine
 * (fs/pipe ports + port-injecting spawn).
 *
 * The coproc child must be LINE-buffered for an interactive round-trip without
 * closing its stdin (the real-bash caveat for block-buffered filters); `cat`
 * flushes per chunk, so it round-trips line-by-line — the canonical coproc demo.
 *
 * Uses the real `@mithic/shell` dist guest + a real Kernel + WorkerRuntime with
 * the production coreutils resolver. REQUIRES `npm run build` first.
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';
import { Executor } from './executor.ts';
import { parse } from './parser.ts';

const FS_RW = [{ type: 'fs' as const, paths: ['/'], operations: ['read' as const, 'write' as const] }];

async function bootShell(): Promise<(script: string) => Promise<{ stdout: string; code: number }>> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const guestUrl = new URL('../dist/process.js', import.meta.url);
  return async (script) => {
    const { pid, stdout } = await kernel.spawn(guestUrl, {
      args: ['bash', '-c', script],
      capabilities: [{ type: 'process' }, ...FS_RW],
      captureStdout: true,
    });
    const { code } = await kernel.wait(pid);
    const bytes = stdout ? await stdout : new Uint8Array();
    return { stdout: new TextDecoder().decode(bytes), code };
  };
}

const T = 15000;

test('A2: coproc round-trip — write a line to the coproc, read its output back', async () => {
  const run = await bootShell();
  // Start `cat` as a named coproc; feed it a line via ${UP[1]}; read the echoed
  // line back via ${UP[0]}. Proves the bidirectional duplex over the spine.
  const out = await run([
    'coproc UP { cat; }',
    'echo hello >&"${UP[1]}"',
    'read -u "${UP[0]}" line',
    'echo "got:$line"',
  ].join('\n'));
  expect(out.stdout).toBe('got:hello\n');
}, T);

test('A2: two round-trips over one coproc preserve order', async () => {
  const run = await bootShell();
  const out = await run([
    'coproc UP { cat; }',
    'echo one >&"${UP[1]}"',
    'read -u "${UP[0]}" a',
    'echo two >&"${UP[1]}"',
    'read -u "${UP[0]}" b',
    'echo "$a $b"',
  ].join('\n'));
  expect(out.stdout).toBe('one two\n');
}, T);

test('A2: COPROC_PID is a real positive child pid', async () => {
  const run = await bootShell();
  const out = await run([
    'coproc CAT { cat; }',
    'if [ "${CAT_PID}" -gt 0 ]; then echo "pid-ok"; else echo "pid-bad:${CAT_PID}"; fi',
    'echo done >&"${CAT[1]}"',
    'read -u "${CAT[0]}" l',
    'echo "$l"',
  ].join('\n'));
  expect(out.stdout).toBe('pid-ok\ndone\n');
}, T);

test('A2: unnamed coproc uses the default COPROC array', async () => {
  const run = await bootShell();
  const out = await run([
    'coproc { cat; }',
    'echo abc >&"${COPROC[1]}"',
    'read -u "${COPROC[0]}" x',
    'echo "$x"',
  ].join('\n'));
  expect(out.stdout).toBe('abc\n');
}, T);

// Backend-gating: a KernelClient WITHOUT spawnCoproc (a non-transferable
// backend, e.g. QuickJS/ivm) emits the precise diagnostic, NOT the old blanket
// "not supported in this runtime".
test('A2: coproc on a non-transferable backend emits the precise diagnostic', async () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const errs: string[] = [];
  const kernel: any = {
    async spawn() { return { pid: 1 }; },
    async wait(pid: number) { return { pid, code: 0 }; },
    // No spawnCoproc → non-transferable backend.
  };
  const ex = new Executor(kernel, { cwd: '/', env: {} }, {
    onStdout: () => {},
    onStderr: (s) => errs.push(s),
    resolve: (n) => n,
  });
  const code = await ex.run(parse('coproc UP { cat; }'));
  expect(code).toBe(1);
  expect(errs.join('')).toContain('coproc: requires a transferable backend');
  expect(errs.join('')).not.toContain('not supported in this runtime');
}, T);

// Backend-gating: a spawnCoproc that rejects ENOSYS (transferable probe failed)
// also surfaces the precise diagnostic.
test('A2: coproc maps a spawnCoproc ENOSYS rejection to the precise diagnostic', async () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const errs: string[] = [];
  const kernel: any = {
    async spawn() { return { pid: 1 }; },
    async wait(pid: number) { return { pid, code: 0 }; },
    async spawnCoproc() { throw Object.assign(new Error('coproc: requires a transferable backend'), { code: 'ENOSYS' }); },
  };
  const ex = new Executor(kernel, { cwd: '/', env: {} }, {
    onStdout: () => {},
    onStderr: (s) => errs.push(s),
    resolve: (n) => n,
  });
  const code = await ex.run(parse('coproc UP { cat; }'));
  expect(code).toBe(1);
  expect(errs.join('')).toContain('coproc: requires a transferable backend');
}, T);
