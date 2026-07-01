/**
 * Regression capstone for compound-statement `< file` stdin redirects
 * (byte-stream stdin, Task 3). A COMPOUND statement (`{ …; }`, `while`, `for`,
 * subshell) that carries a `< file` redirect must install that file as the
 * frame's stdin stream so the inner `read`/`cat`/… builtins consume it over one
 * shared cursor. Before the fix, `applyRedirects` `continue`d past input
 * redirects, so the compound body fell through to the never-written live root
 * stdin and HUNG.
 *
 * Each test has a per-test timeout so a regression FAILS (times out) instead of
 * hanging the whole suite. REQUIRES all packages built (`npm run build`).
 */
import { expect, test } from 'vitest';
import { createCoreutilsResolver } from '@mithic/coreutils';

/**
 * Boot a real Kernel + WorkerRuntime + coreutils resolver over a MemoryFs seeded
 * with `/data.txt` = `seed` (plus any `extraFiles`), run `script`, and return
 * captured stdout as text.
 */
async function run(
  script: string,
  seed = 'alpha\nbeta\ngamma\n',
  extraFiles?: Record<string, string>,
): Promise<string> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  const h = fs.open('/data.txt', { write: true, create: true });
  fs.write(h, new TextEncoder().encode(seed), 0);
  fs.close(h);

  for (const [path, content] of Object.entries(extraFiles ?? {})) {
    const eh = fs.open(path, { write: true, create: true });
    fs.write(eh, new TextEncoder().encode(content), 0);
    fs.close(eh);
  }

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const { pid, stdout } = await kernel.spawn(new URL('../dist/process.js', import.meta.url), {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  return new TextDecoder().decode(stdout ? await stdout : new Uint8Array());
}

/**
 * Like {@link run}, but seeds `/data.bin` with RAW bytes and returns captured
 * stdout as a `Uint8Array` (NO decode) so binary payloads can be asserted
 * byte-for-byte.
 */
async function runBytes(bytesSeed: number[], script: string): Promise<Uint8Array> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);
  const fs = new MemoryFsProvider({ files: {} });
  const vfs = new FileSystemRouter();
  await vfs.mount('/', fs);

  const h = fs.open('/data.bin', { write: true, create: true });
  fs.write(h, new Uint8Array(bytesSeed), 0);
  fs.close(h);

  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand: createCoreutilsResolver() });
  const { pid, stdout } = await kernel.spawn(new URL('../dist/process.js', import.meta.url), {
    args: ['bash', '-c', script],
    capabilities: [{ type: 'process' }, { type: 'fs', paths: ['/'], operations: ['read', 'write'] }],
    captureStdout: true,
  });
  await kernel.wait(pid);
  return stdout ? await stdout : new Uint8Array();
}

test('while read line; do …; done < file streams all lines (no hang)', async () => {
  expect(await run('while read l; do echo "got:$l"; done < /data.txt'))
    .toBe('got:alpha\ngot:beta\ngot:gamma\n');
}, 15000);

test('{ read a; read b; } < file advances the cursor (no hang)', async () => {
  expect((await run('{ read a; read b; } < /data.txt; echo "$a|$b"')).trim()).toBe('alpha|beta');
}, 15000);

test('pipe into while read streams (no OOM/hang)', async () => {
  expect(await run('printf "one\\ntwo\\nthree\\n" | while read l; do echo "L=$l"; done'))
    .toBe('L=one\nL=two\nL=three\n');
}, 15000);

test('for loop body reads from a < redirect on the loop', async () => {
  expect((await run('for i in 1 2; do read x; echo "$i:$x"; done < /data.txt')).trim())
    .toBe('1:alpha\n2:beta');
}, 15000);

test('a binary body streams through an in-process pipe byte-exact', async () => {
  // 0x00 0xff 0xfe — bytes that are NOT valid UTF-8 — must survive a pipe intact.
  // `cat /data.bin` reads the raw file (byte-exact) and pipes it to `cat`, whose
  // stdin is the byte-stream. A stdin path that decoded to a string and re-encoded
  // would turn 0xff/0xfe into the U+FFFD replacement (0xef 0xbf 0xbd) — this
  // asserts the exact bytes, so it FAILS on any corrupting implementation.
  const body = await runBytes([0x00, 0xff, 0xfe], 'cat /data.bin | cat');
  expect(Array.from(body)).toEqual([0x00, 0xff, 0xfe]);
}, 15000);

test('a lone continuation byte survives an in-process pipe byte-exact', async () => {
  // 0x80 on its own is an invalid UTF-8 lead — a decode/re-encode round-trip
  // would drop or replace it. Interleaving valid + invalid bytes proves the
  // stdin stream is byte-core, not text.
  const body = await runBytes([0x00, 0xff, 0xfe, 0x01, 0x80], 'cat /data.bin | cat');
  expect(Array.from(body)).toEqual([0x00, 0xff, 0xfe, 0x01, 0x80]);
}, 15000);

// FIX 2 (item A): a `< file` redirect into a builtin reads the file byte-safe.
// The builtin `cat` (no operands) consumes its stdin STREAM, which is now sourced
// from FsClient.fsReadBytes (no TextDecoder round-trip). Regression: fsRead
// decoded the kernel's Uint8Array to a string (0xff/0xfe → U+FFFD) then re-encoded.
test('< file into a builtin cat is byte-safe (no UTF-8 corruption)', async () => {
  const body = await runBytes([0x00, 0xff, 0xfe, 0x41], 'cat < /data.bin');
  expect(Array.from(body)).toEqual([0x00, 0xff, 0xfe, 0x41]);
}, 15000);

test('a large piped input streams through while-read without OOM', async () => {
  // 5000 lines piped into a while-read loop that just counts — proves it completes
  // (a full-buffer-forever bug would hang/OOM). The lines are pre-seeded into a
  // file (built in JS) and streamed via `cat file | while read`.
  const big = Array.from({ length: 5000 }, (_, i) => String(i)).join('\n') + '\n';
  const out = await run('cat /big.txt | while read l; do :; done; echo done', undefined, { '/big.txt': big });
  expect(out.trim()).toBe('done');
}, 20000);

// ── shared-cursor across builtin + EXTERNAL in one compound `< file` frame ──────
// The stdin stream must be drained through ONE shared reader; a second getReader()
// on a locked stream throws `TypeError: ReadableStream is locked`.

test('while read with an EXTERNAL command in the body does not double-lock stdin', async () => {
  // The loop `read` locks the frame stream; the body pipes into an external `cat`.
  // Regression: a fresh reader for the external threw "ReadableStream is locked".
  expect(await run('while read l; do echo "$l" | cat; done < /data.txt'))
    .toBe('alpha\nbeta\ngamma\n');
}, 15000);

test('{ read h; EXTERNAL; } < file shares one cursor (external reads where read left off)', async () => {
  // `read h` consumes line 1 (alpha); the external `head -n1` must read line 2
  // (beta) from the SAME cursor, not restart or crash on a locked stream.
  expect((await run('{ read h; head -n1; } < /data.txt; echo "h=$h"')).trim())
    .toBe('beta\nh=alpha');
}, 15000);

// ── a side-effecting redirect on a SIMPLE command is resolved exactly ONCE ───────
test('read x <<< "$(side-effect)" runs the command substitution once', async () => {
  // Regression: the input redirect was resolved in BOTH execSimpleCommand and
  // applyRedirects, running the here-string command substitution twice.
  const out = await run(
    'read x <<< "$(echo hi; echo tick >> /cnt)"; echo "x=$x"; cat /cnt',
    undefined,
    { '/cnt': '' },
  );
  expect(out).toBe('x=hi\ntick\n'); // exactly ONE "tick" line
}, 15000);

// FIX 4 (item H): a nested pipeline's FIRST stage inherits the enclosing compound
// stage's stdin. Regression: execMultiStagePipeline zeroed stage-0 stdin, so a
// pipeline inside a group whose stdin is the group frame (an outer pipe or the
// group's own `< file`) hung — the inner first stage never got the stdin.
test('echo hi | { cat | tr a-z A-Z; } — nested pipeline inherits the outer pipe', async () => {
  expect(await run('echo hi | { cat | tr a-z A-Z; }')).toBe('HI\n');
}, 15000);

test('{ cat | tr a-z A-Z; } < /dev/null — nested pipeline over group < redirect (no hang)', async () => {
  // No outer pipe: the group's own `< /dev/null` is the inner pipeline's stdin.
  // Before the fix the inner `cat` got empty-hardcoded/zeroed stdin and could hang
  // (or never see the group redirect). Must produce empty output, exit 0, no hang.
  expect(await run('{ cat | tr a-z A-Z; } < /dev/null')).toBe('');
}, 15000);

test('echo hi | { cat; } — single-command group inherits the outer pipe', async () => {
  expect(await run('echo hi | { cat; }')).toBe('hi\n');
}, 15000);

// A TOP-LEVEL pipeline whose stage 0 legitimately has no stdin must not block:
// `echo x | cat` — echo ignores stdin; must not start reading the never-EOF root.
test('echo x | cat — top-level pipeline stage 0 does not block on the root stream', async () => {
  expect(await run('echo x | cat')).toBe('x\n');
}, 15000);

// FIX 3 (item C): a `< file` on a BUILTIN first pipeline stage in an all-builtin
// pipeline must be honored. Regression: the all-builtin branch hardcoded stage-0
// stdin to empty, so `cat < f | cat` produced nothing.
test('< file on a builtin first stage in an all-builtin pipeline is honored', async () => {
  // `cat < /f | cat` — both `cat`s are builtins (no operands). Stage 0 must read
  // /f from its `<` redirect; today it starts empty ⇒ empty output.
  expect(await run('cat < /f | cat', undefined, { '/f': 'hello\nworld\n' }))
    .toBe('hello\nworld\n');
}, 15000);

test('<<< here-string on a builtin first stage in an all-builtin pipeline is honored', async () => {
  expect(await run('cat <<< hi | cat')).toBe('hi\n');
}, 15000);

// FIX 1 (item G): an EXTERNAL command's `<<< "$(cmd)"` must resolve the redirect
// ONCE. Regression: execSimple resolved the redirect via resolveStdinStream AND
// then (for an external) again via resolveStdinFd, running the substitution twice.
test('EXTERNAL <<< "$(side-effect)" runs the command substitution once', async () => {
  // `cat` is an EXTERNAL (has an operand? no — but here it reads its here-string
  // stdin). The command substitution appends one `tick` to /cnt; a double
  // resolution would append it twice. Use `grep` (always external) to be safe.
  const out = await run(
    'grep -c . <<< "$(echo hi; echo tick >> /cnt)"; cat /cnt',
    undefined,
    { '/cnt': '' },
  );
  // grep -c counts matching lines of the here-string ("hi\n" → 1). /cnt must hold
  // exactly ONE "tick" (two ⇒ the substitution ran twice).
  expect(out).toBe('1\ntick\n');
}, 15000);

// FIX 6 (item I): a `$(…)` inside a COMPOUND stage inherits the enclosing
// command's stdin. Regression: runCommandSub / runCommandSubRaw derived the
// capture frame with `stdin: undefined`, so the inner `$(cat)` command got NO
// stdin and read empty — `echo x | { echo "got=$(cat)"; }` printed `got=`.
test('echo x | { echo "got=$(cat)"; } — $(cat) inherits the piped stdin', async () => {
  expect((await run('echo x | { echo "got=$(cat)"; }')).trim()).toBe('got=x');
}, 15000);

test('echo x | echo "got=$(cat)" — $(cat) in a simple piped stage inherits stdin', async () => {
  expect((await run('echo x | echo "got=$(cat)"')).trim()).toBe('got=x');
}, 15000);

test('printf a | { v=$(cat); echo "v=$v"; } — assignment $(cat) inherits stdin', async () => {
  expect((await run('printf \'a\\n\' | { v=$(cat); echo "v=$v"; }')).trim()).toBe('v=a');
}, 15000);

// Guard: a plain `$(echo hi)` (no stdin consumer) still works — inheriting the
// ambient stdin must not break the common case (echo ignores stdin).
test('plain $(echo hi) still expands correctly (no stdin double-consume)', async () => {
  expect((await run('echo "v=$(echo hi)"')).trim()).toBe('v=hi');
}, 15000);

// Guard: `echo hi | grep $(echo h)` — the `$(echo h)` sub inherits the pipe
// stdin but `echo` never reads it, so `grep h` still receives `hi` from the
// pipe and matches. A sub that wrongly drained the pipe would starve grep.
test('echo hi | grep $(echo h) — a non-reading sub does not steal the pipe', async () => {
  expect((await run('echo hi | grep $(echo h)')).trim()).toBe('hi');
}, 15000);
