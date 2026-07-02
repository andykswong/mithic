/* eslint-disable @typescript-eslint/no-explicit-any -- read-timeout tests use a mock kernel + controllable duplex fd */
/**
 * A3 Tier 1 — `read -u N -t T` timeout over a LIVE duplex fd.
 *
 * Plain `read` consumes a pre-materialized stdin STRING (Tier 2, deferred to a
 * later stage). But `read -u N` over a duplex fd (`exec N<>/dev/tcp/...`) is
 * ALREADY a live awaited stream (`readFdLine` → `DuplexFd.readLine()`), so the
 * timeout is implemented by racing that await against a timer: on timeout the
 * builtin returns bash's read-timeout exit status (>128; specifically 142 =
 * 128 + SIGALRM) and leaves the target var empty. Because the in-flight
 * `readLine()` buffers consumed bytes in `DuplexFd.pending`, a lost race drops
 * no data — verified by a follow-up read that still sees the late-arriving line.
 */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import type { DuplexFd, FsClient } from './kernel-client.ts';

/**
 * A controllable duplex fd: `readLine()` resolves only when the harness feeds a
 * line. This lets a test decide whether data arrives before or after the
 * timeout window deterministically (no real sockets / wall-clock races).
 */
function controllableDuplex(): { fd: DuplexFd; feed(line: string): void; eof(): void } {
  const queue: string[] = [];
  let waiter: ((v: string | undefined) => void) | undefined;
  let closed = false;
  const fd: DuplexFd = {
    write() { /* not exercised here */ },
    readLine(): Promise<string | undefined> {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => { waiter = resolve; });
    },
    close() { closed = true; },
  };
  return {
    fd,
    feed(line: string) {
      if (waiter) { const w = waiter; waiter = undefined; w(line); }
      else queue.push(line);
    },
    eof() {
      closed = true;
      if (waiter) { const w = waiter; waiter = undefined; w(undefined); }
    },
  };
}

/** A mock FsClient whose `<>` opens return a pre-built controllable duplex fd. */
function duplexFs(fd: DuplexFd): FsClient {
  return {
    fsOpen() { return 1; },
    fsWrite() { /* unused */ },
    fsRead() { return ''; },
    fsClose() { /* unused */ },
    fsStat() { return undefined; },
    fsOpenDuplex() { return fd; },
  };
}

function mk(fs: FsClient) {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = '';
  let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n, fs,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

// ── data arrives within the timeout → success with the data ──────────────────

test('read -u N -t T succeeds when a line arrives before the timeout', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  // Deliver the line immediately, then run the read with a comfortable timeout.
  ctl.feed('hello world');
  const code = await h.ex.exec('exec 3<>/dev/tcp/x/1\nread -u 3 -t 5 a b\necho "rc=$? a=$a b=$b"');
  expect(code).toBe(0);
  expect(h.out.trim()).toBe('rc=0 a=hello b=world');
});

// ── no data within the timeout → >128 exit and an empty/unset var ────────────

test('read -u N -t T times out → exit 142 and empty var when no data arrives', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd)); // never feed → readLine never resolves
  // A fractional 0.05s timeout keeps the test fast (bash accepts -t 0.05).
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread -u 3 -t 0.05 reply\necho "rc=$? reply=[$reply]"');
  expect(h.out.trim()).toBe('rc=142 reply=[]');
});

// ── -tT (glued) form also parses ─────────────────────────────────────────────

test('read -u N -t0.05 (glued) times out → exit 142', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread -u 3 -t0.05 reply\necho "rc=$?"');
  expect(h.out.trim()).toBe('rc=142');
});

// ── partial-line data is NOT lost on a lost race (DuplexFd.pending) ───────────

test('a line arriving AFTER a timed-out read is still readable next (no data dropped)', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  // First read times out (nothing fed yet). Then the line arrives late; a second
  // read with a generous timeout must see it — the duplex fd retained it.
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread -u 3 -t 0.05 a\necho "first=$? a=[$a]"');
  expect(h.out.trim()).toBe('first=142 a=[]');
  ctl.feed('late-line');
  await h.ex.exec('read -u 3 -t 5 b\necho "second=$? b=[$b]"');
  expect(h.out.trim().split('\n').pop()).toBe('second=0 b=[late-line]');
});

// ── a timeout on a duplex fd returns 0 if the line is already buffered ────────

test('read -u N -t T returns the already-buffered line without waiting', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  ctl.feed('one');
  ctl.feed('two');
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread -u 3 -t 0.01 x\nread -u 3 -t 0.01 y\necho "$x $y"');
  expect(h.out.trim()).toBe('one two');
});

// ── `<&N` input fd-dup: `read <&3` sources from fd 3 (in-process coverage of the
//    applyRedirects `<&` branch + the stdinDupFds precise-alias tracking) ───────

test('read <&3 sources from fd 3 (input fd-dup), advancing fd 3 cursor', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  ctl.feed('L1');
  ctl.feed('L2');
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread a <&3\nread b <&3\necho "a=$a b=$b"');
  expect(h.out.trim()).toBe('a=L1 b=L2');
});

test('read <&3 alias is per-command: a following plain read reverts to normal stdin', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  ctl.feed('FROM3');
  // After `read a <&3`, the fd-0 alias must be torn down (stdinDupFds cleared by
  // the restore closure) so a subsequent plain `read` does NOT still read fd 3.
  // With no live stdin stream, the plain read hits EOF (rc 1) rather than fd 3.
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread a <&3\nread b\necho "a=$a rc=$? b=[$b]"');
  expect(h.out.trim()).toBe('a=FROM3 rc=1 b=[]');
});

test('read -t over a <&3 input-dup times out (142) when fd 3 has no data', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd)); // never feed
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread -t 0.05 -r r <&3\necho "rc=$? r=[$r]"');
  expect(h.out.trim()).toBe('rc=142 r=[]');
});

test('<&- closes the input fd (read then hits EOF)', async () => {
  const ctl = controllableDuplex();
  const h = mk(duplexFs(ctl.fd));
  ctl.feed('X');
  // `exec 3<&-`-style close via a per-command `<&-` on fd 0: nothing to read.
  await h.ex.exec('exec 3<>/dev/tcp/x/1\nread a <&-\necho "rc=$? a=[$a]"');
  expect(h.out.trim()).toBe('rc=1 a=[]');
});

test('read <&3 over a DATAGRAM duplex fd uses readDatagram (one datagram, not a line)', async () => {
  // A datagram fd (`datagram:true`) routes readFdLine through readDatagram — one
  // whole datagram per read, no `\n` splitting. Two datagrams → two reads.
  const dgrams = ['first-datagram', 'second\ndatagram-with-newline'];
  let i = 0;
  const dfd: DuplexFd = {
    datagram: true,
    write() { /* unused */ },
    readLine() { throw new Error('readLine must NOT be used for a datagram fd'); },
    readDatagram() { return Promise.resolve(i < dgrams.length ? dgrams[i++] : undefined); },
    close() { /* unused */ },
  };
  const h = mk(duplexFs(dfd));
  await h.ex.exec('exec 3<>/dev/udp/x/1\nread -r a <&3\necho "a=[$a]"');
  // The whole first datagram (no line-splitting) lands in $a.
  expect(h.out.trim()).toBe('a=[first-datagram]');
});
