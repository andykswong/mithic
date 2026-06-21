/* eslint-disable @typescript-eslint/no-explicit-any -- mock kernel + controllable stdin stream */
/**
 * A3 Tier 2 — live-stdin `read` / `read -t` over a ReadableStream.
 *
 * Tier 1 handled `read -u N -t T` over a duplex fd. Tier 2 generalizes the
 * timeout (and sequential line reads) to PLAIN `read` over the shell's own
 * stdin, which is now a live `ReadableStream` rather than a pre-materialized
 * string: `read x; read y` consume successive lines, and `read -t T` over a
 * stream that has no data yet (and is not at EOF) times out with bash's >128
 * exit. The existing string-stdin paths (here-docs, pipeStdin, select) are
 * preserved.
 */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mockKernel() {
  return { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
}

/** A controllable live stdin stream: feed lines, or leave it pending (no EOF). */
function controllableStdin(): { stream: ReadableStream<Uint8Array>; feed(s: string): void; close(): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    stream,
    feed(s) { controller.enqueue(enc.encode(s)); },
    close() { try { controller.close(); } catch { /* already closed */ } },
  };
}

function mk(stdinStream?: ReadableStream<Uint8Array>) {
  let out = '';
  let err = '';
  const ex = new Executor(mockKernel() as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n, stdinStream,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

test('A3-T2: sequential plain reads consume successive lines from the live stdin stream', async () => {
  const ctl = controllableStdin();
  const h = mk(ctl.stream);
  ctl.feed('a\nb\n');
  ctl.close();
  const code = await h.ex.exec('read x\nread y\necho "$x-$y"');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('a-b');
});

test('A3-T2: read -t over an empty (not-yet-EOF) stdin stream times out with >128', async () => {
  const ctl = controllableStdin(); // never feed, never close → genuinely pending
  const h = mk(ctl.stream);
  await h.ex.exec('read -t 0.1 reply\necho "rc=$? reply=[$reply]"');
  expect(h.out.trim()).toBe('rc=142 reply=[]');
});

test('A3-T2: read -t succeeds when a line arrives before the timeout', async () => {
  const ctl = controllableStdin();
  const h = mk(ctl.stream);
  ctl.feed('hello world\n');
  const code = await h.ex.exec('read -t 5 a b\necho "rc=$? a=$a b=$b"');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('rc=0 a=hello b=world');
});

test('A3-T2: a line arriving AFTER a timed-out read is still readable next (no data dropped)', async () => {
  const ctl = controllableStdin();
  const h = mk(ctl.stream);
  await h.ex.exec('read -t 0.1 a\necho "first=$? a=[$a]"');
  expect(h.out.trim()).toBe('first=142 a=[]');
  ctl.feed('late\n');
  await h.ex.exec('read -t 5 b\necho "second=$? b=[$b]"');
  expect(h.out.trim().split('\n').pop()).toBe('second=0 b=[late]');
});

test('A3-T2: here-doc still feeds read via the string path (unchanged)', async () => {
  const h = mk(); // no live stdin stream
  const code = await h.ex.exec('read x <<EOF\nfromheredoc\nEOF\necho "[$x]"');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('[fromheredoc]');
});
