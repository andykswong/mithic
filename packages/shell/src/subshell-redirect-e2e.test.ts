/**
 * FIX 5 (item B): a subshell `( … )` must apply its OWN redirects.
 *
 * Regression: `execSubshell` ran the body via `execList` WITHOUT applying
 * `stmt.redirects`, so `( read x ) < file` fell through to the never-fed root
 * stdin and HUNG, and `( echo hi ) > out` leaked to the parent's stdout instead
 * of the file. Group/While/For/Select all route through `withRedirects`; the
 * subshell must too (composed INLINE so it stacks with the subshell's own
 * exit-isolation + forked fd-table).
 *
 * Real-kernel e2e (Kernel + WorkerRuntime + coreutils over a MemoryFs). Each
 * test carries a per-test timeout so a hang FAILS (times out) rather than
 * wedging the suite. REQUIRES all packages built (`npm run build`).
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';

/**
 * Boot a real Kernel + WorkerRuntime + coreutils resolver over an EMPTY
 * MemoryFs (seed files in-script with printf/echo), run `script`, and return
 * captured stdout as text.
 */
async function run(script: string): Promise<string> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const { pid, stdout } = await kernel.spawn(new URL('../dist/process.js', import.meta.url), {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  return new TextDecoder().decode(stdout ? await stdout : new Uint8Array());
}

test('( read x ) < file feeds the subshell (no hang)', async () => {
  // Before the fix the inner `read` fell through to the unfed root stdin → HANG.
  expect((await run('printf \'ALPHA\\n\' > /f; ( read x; echo "got=$x" ) < /f')).trim())
    .toBe('got=ALPHA');
}, 15000);

test('( echo hi ) > out redirects the subshell stdout to the file (no leak)', async () => {
  // Before the fix `hi` leaked to the parent stdout and /o stayed empty. A weak
  // `cat /o` assertion can't tell a leak apart from a correct redirect (both
  // print `hi`), so assert the ordering: the subshell writes NOTHING to the
  // parent stdout, then a marker prints, THEN `cat /o` shows the captured `hi`.
  expect(await run('( echo hi ) > /o; echo marker; cat /o'))
    .toBe('marker\nhi\n');
}, 15000);

test('( read x ) <<< "hs" — here-string feeds the subshell (no hang)', async () => {
  expect((await run('( read x ) <<< "hs"; echo done')).trim()).toBe('done');
}, 15000);

test('subshell exit isolation is preserved: ( exit 5 ); parent continues', async () => {
  // An `exit` inside the subshell ends ONLY the subshell with its code; the
  // redirect apply/restore must nest INSIDE the savedExiting save/restore so
  // this still holds.
  expect((await run('( exit 5 ); echo "code=$?"')).trim()).toBe('code=5');
}, 15000);
