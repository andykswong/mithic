/* eslint-disable @typescript-eslint/no-explicit-any -- bg-sink-race tests drive a hand-built mock kernel typed as any */
/**
 * D3 — per-command I/O context (background-job sink data race).
 *
 * THE BUG: the executor used to route ALL output through INSTANCE FIELDS
 * (`this.stdoutSink` / `this.stderrSink` / `this.pipeStdin`). A backgrounded job
 * shares those live fields with the foreground, so a bg producer that resumes
 * after an `await` writes through whatever sink the foreground LAST installed —
 * a `> file` redirect, or a `$(...)` command-substitution capture buffer.
 *
 * These tests background a SLOW external producer and arrange (deterministically,
 * no sleeps) for it to resume EXACTLY WHILE a foreground command's redirect /
 * capture sink is installed. With the shared-field design the bg bytes land in
 * the foreground's sink; with a per-command I/O context they cannot.
 *
 * Timing is controlled with barriers wired through the mock kernel:
 *  - the bg producer parks on `bgRelease` (its stdout promise);
 *  - the FOREGROUND command parks on `fgWait` (its kernel.wait) WHILE its
 *    redirect/capture sink is the live one;
 *  - the test releases the bg producer first (it resumes mid-foreground), then
 *    releases the foreground command.
 */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** In-memory VFS recording final file contents. */
function mockFs() {
  const files = new Map<string, string>();
  const open = new Map<number, { path: string; mode: 'w' | 'a' | 'r'; buf: string }>();
  let nextFd = 10;
  return {
    files,
    fsOpen(path: string, flags: { read?: boolean; write?: boolean; append?: boolean; truncate?: boolean }): number {
      const fd = nextFd++;
      let buf = '';
      if (flags.append && files.has(path)) buf = files.get(path)!;
      open.set(fd, { path, mode: flags.read ? 'r' : flags.append ? 'a' : 'w', buf });
      return fd;
    },
    fsWrite(fd: number, data: string): void { const e = open.get(fd); if (!e) throw new Error('bad fd'); e.buf += data; },
    fsRead(fd: number): string { const e = open.get(fd); if (!e) throw new Error('bad fd'); return files.get(e.path) ?? ''; },
    fsClose(fd: number): void { const e = open.get(fd); if (!e) return; if (e.mode !== 'r') files.set(e.path, e.buf); open.delete(fd); },
    fsStat(path: string): { dir: boolean } | undefined { return files.has(path) ? { dir: false } : undefined; },
  };
}

/**
 * Build a kernel where:
 *  - `bgproducer`: stdout resolves to `BG_LEAK\n` only when `bgRelease` resolves;
 *    its `wait` resolves right after.
 *  - `fgcmd`: stdout is empty, but its `wait` parks until `fgRelease` resolves —
 *    so the foreground command's redirect/capture sink stays the live sink
 *    across an `await`, which is the bug window.
 *  - `fgStarted` resolves once the foreground command has been spawned (so the
 *    test knows the foreground redirect sink is now installed).
 */
function mkRaceKernel() {
  const bgRelease = deferred<void>();
  const fgRelease = deferred<void>();
  const fgStarted = deferred<void>();
  const k = {
    async spawn(params: any) {
      const name = params.args?.[0];
      if (name === 'bgproducer') {
        return { pid: 4242, stdout: bgRelease.promise.then(() => new TextEncoder().encode('BG_LEAK\n')) };
      }
      if (name === 'fgcmd') {
        fgStarted.resolve();
        return { pid: 7, stdout: Promise.resolve(new Uint8Array()) };
      }
      return { pid: 1, stdout: Promise.resolve(new Uint8Array()) };
    },
    async wait(pid: number) {
      if (pid === 4242) { await bgRelease.promise; return { pid, code: 0 }; }
      if (pid === 7) { await fgRelease.promise; return { pid, code: 0 }; }
      return { pid, code: 0 };
    },
  };
  return { k, bgRelease, fgRelease, fgStarted };
}

test('D3: a backgrounded producer NEVER writes into a foreground `> file` redirect', async () => {
  const { k, bgRelease, fgRelease, fgStarted } = mkRaceKernel();
  const fs = mockFs();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: () => {}, resolve: (n) => n, fs: fs as any,
  });

  // bgproducer parks on its stdout; fgcmd installs a `> /tmp/f` redirect sink and
  // parks on its wait. While fgcmd is parked, the redirect sink is the live one.
  const run = ex.exec('bgproducer &\nfgcmd > /tmp/f');

  await fgStarted.promise;          // foreground redirect sink now installed
  bgRelease.resolve();              // bg producer resumes MID-foreground
  await new Promise((r) => setTimeout(r, 0)); // let bg writeCaptured run
  fgRelease.resolve();              // foreground completes, restores sink
  await run;
  await (ex as any).waitAllJobs?.();
  await new Promise((r) => setTimeout(r, 0));

  // /tmp/f exists (fgcmd's empty redirect) but must NOT contain bg bytes.
  expect(fs.files.get('/tmp/f') ?? '').not.toContain('BG_LEAK');
});

test('D3: a backgrounded producer NEVER pollutes a foreground `$(...)` capture', async () => {
  // The SECOND misroute target named in D3 — a `$(...)` command-substitution
  // capture buffer. The bg producer resumes WHILE `CAP=$(fgcmd; echo captured)`
  // is capturing (fgcmd parked on its wait, the capture sink installed). With the
  // old shared-field design the bg bytes landed in the capture (CAP would be
  // `BG_LEAK\ncaptured`); with the per-command I/O context the capture is exactly
  // `captured` and the bg producer's bytes go to its OWN frame's terminal stdout.
  const { k, bgRelease, fgRelease, fgStarted } = mkRaceKernel();
  let out = '';
  let cap: string | undefined;
  const ex = new Executor(k as any, { cwd: '/', env: { } } as any, {
    onStdout: (s) => { out += s; }, onStderr: () => {}, resolve: (n) => n,
  });

  // `printf %s "[$CAP]"` (no trailing newline) makes the exact captured value
  // easy to assert from terminal stdout.
  const run = ex.exec('bgproducer &\nCAP=$(fgcmd; printf captured)\nprintf "<%s>" "$CAP"');

  await fgStarted.promise;
  bgRelease.resolve();
  await new Promise((r) => setTimeout(r, 0));
  fgRelease.resolve();
  await run;
  await (ex as any).waitAllJobs?.();
  await new Promise((r) => setTimeout(r, 0));

  // CAP captured ONLY the cmd-sub body output — never the bg producer's bytes.
  const m = out.match(/<([^>]*)>/);
  cap = m?.[1];
  expect(cap).toBe('captured');
});
