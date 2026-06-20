/**
 * End-to-end proof of the whole jq mechanism:
 *   resolveJq → kernel spawn → defineCommand → createGuest → stdio → exit.
 *
 * Boots a real Kernel over a WorkerRuntime with `resolveCommand = resolveJq`,
 * and spawns `jq` for real. In a Node/vitest env `Worker` is undefined, so the
 * kernel's in-process launcher imports the BUILT `dist/jq.js` module by URL and
 * runs it on the same thread. A small inline producer guest streams JSON into
 * jq's stdin (jq reads stdin, applies the filter, writes results to stdout).
 *
 * REQUIRES the package to be built first (`npm run build -w @mithic/jq`) so
 * `dist/jq.js` exists — the resolver hands the kernel that file URL.
 */
import { expect, test } from 'vitest';
import { resolveJq } from './resolver.ts';

async function bootKernel(): Promise<{
  jq: (input: string, args: string[]) => Promise<{ stdout: string; code: number }>;
  resolve: typeof resolveJq;
}> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  // jq reads stdin, not the VFS, but the Kernel requires a vfs — mount an empty one.
  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: resolveJq });

  // An inline producer guest that writes `input` to stdout then closes + exits.
  const producerFor = (input: string): string =>
    `import { createGuest } from '@mithic/guest-runtime';
     export default async (boot) => {
       const g = createGuest(boot);
       const w = g.stdout.getWriter();
       await w.write(new TextEncoder().encode(${JSON.stringify(input)}));
       await w.close();
       g.exit(0);
     };`;

  return {
    resolve: resolveJq,
    async jq(input, args) {
      const code = resolveJq('jq', '/', {})!;
      const result = await kernel.runPipeline([
        { code: producerFor(input), args: ['producer'] },
        { code, args: ['jq', ...args], captureStdout: true },
      ]);
      const bytes = result.lastStdout ? await result.lastStdout : new Uint8Array();
      return { stdout: new TextDecoder().decode(bytes), code: result.exitCodes[result.exitCodes.length - 1] };
    },
  };
}

test('echo {"a":[1,2,3]} | jq ".a | map(.+1)" → [2,3,4]', async () => {
  const k = await bootKernel();
  const out = await k.jq('{"a":[1,2,3]}', ['.a | map(.+1)']);
  expect(JSON.parse(out.stdout)).toEqual([2, 3, 4]);
  expect(out.code).toBe(0);
}, 20000);

test('jq -r ".name" emits a raw string (no quotes)', async () => {
  const k = await bootKernel();
  const out = await k.jq('{"name":"andy"}', ['-r', '.name']);
  expect(out.stdout).toBe('andy\n');
  expect(out.code).toBe(0);
}, 20000);

test('jq -c compact output', async () => {
  const k = await bootKernel();
  const out = await k.jq('{"a":1,"b":2}', ['-c', '.']);
  expect(out.stdout).toBe('{"a":1,"b":2}\n');
}, 20000);

test('jq .[] streams multiple outputs (one per line)', async () => {
  const k = await bootKernel();
  const out = await k.jq('[1,2,3]', ['-c', '.[]']);
  expect(out.stdout).toBe('1\n2\n3\n');
}, 20000);

test('jq -s slurp collects the input stream into one array', async () => {
  const k = await bootKernel();
  const out = await k.jq('1 2 3', ['-c', '-s', '.']);
  expect(out.stdout).toBe('[1,2,3]\n');
}, 20000);

test('jq -n null-input runs the program once with null', async () => {
  const k = await bootKernel();
  const out = await k.jq('', ['-cn', '{hello: "world"}']);
  expect(out.stdout).toBe('{"hello":"world"}\n');
}, 20000);

test('jq --arg binds a named string variable', async () => {
  const k = await bootKernel();
  const out = await k.jq('{}', ['-r', '--arg', 'who', 'team', '"hi \\($who)"']);
  expect(out.stdout).toBe('hi team\n');
}, 20000);

test('jq @base64 format string', async () => {
  const k = await bootKernel();
  const out = await k.jq('"hello"', ['-r', '@base64']);
  expect(out.stdout).toBe('aGVsbG8=\n');
}, 20000);

test('jq group_by + map over real JSON', async () => {
  const k = await bootKernel();
  const input = '[{"t":"a","n":1},{"t":"b","n":2},{"t":"a","n":3}]';
  const out = await k.jq(input, ['-c', 'group_by(.t) | map({t: .[0].t, sum: (map(.n) | add)})']);
  expect(JSON.parse(out.stdout)).toEqual([{ t: 'a', sum: 4 }, { t: 'b', sum: 2 }]);
}, 20000);

test('jq halt_error sets a non-zero exit code (not swallowed by try)', async () => {
  const k = await bootKernel();
  const out = await k.jq('"boom"', ['-n', 'try halt_error catch "swallowed"']);
  // halt_error unwinds past `try`; exit code is 5, nothing reaches stdout.
  expect(out.code).toBe(5);
  expect(out.stdout).toBe('');
}, 20000);

test('jq halt exits 0 with no output even inside try', async () => {
  const k = await bootKernel();
  const out = await k.jq('1', ['try halt catch "x"']);
  expect(out.code).toBe(0);
  expect(out.stdout).toBe('');
}, 20000);

test('jq inputs slurps the rest of the stream after the first input', async () => {
  const k = await bootKernel();
  const out = await k.jq('1 2 3 4', ['-c', '-n', '[inputs]']);
  expect(out.stdout).toBe('[1,2,3,4]\n');
}, 20000);

test('jq input pulls the next value from the stream', async () => {
  const k = await bootKernel();
  const out = await k.jq('1 2 3', ['-c', '. + input']);
  // input 1 → 1+2=3; then input 3 has no following value (the loop already
  // consumed 2 via `input`), so the third top-level run errors but exits 5.
  expect(out.stdout).toBe('3\n');
}, 20000);

test('jq @uri encodes the full reserved set through the CLI', async () => {
  const k = await bootKernel();
  const out = await k.jq('"a!b*c(d)"', ['-r', '@uri']);
  expect(out.stdout).toBe('a%21b%2Ac%28d%29\n');
}, 20000);

test('jq invalid @format reports a jq: error and exits 5 (no crash)', async () => {
  const k = await bootKernel();
  const out = await k.jq('"x"', ['@nope']);
  expect(out.code).toBe(5);
  expect(out.stdout).toBe('');
}, 20000);

test('unknown command resolves to undefined (kernel would ENOENT)', () => {
  expect(resolveJq('not-jq', '/', {})).toBeUndefined();
  expect(resolveJq('jq', '/', {})).toBeInstanceOf(URL);
});
