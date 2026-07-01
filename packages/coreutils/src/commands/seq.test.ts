import { expect, test, describe } from 'vitest';
import { seqCommand } from './seq.ts';
import { applySeqFormat } from './seq.ts';
import type { CommandIO } from '../harness.ts';

function makeIO(args: string[]) {
  const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({ write(c) { outChunks.push(c); } });
  const stderr = new WritableStream<Uint8Array>({ write(c) { errChunks.push(c); } });
  const decode = (chunks: Uint8Array[]): string => {
    let t = 0; for (const c of chunks) t += c.byteLength;
    const b = new Uint8Array(t); let o = 0;
    for (const c of chunks) { b.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(b);
  };
  return {
    io: { args, env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO,
    out: () => decode(outChunks),
    err: () => decode(errChunks),
  };
}

describe('seq', () => {
  test('seq 3 → 1\\n2\\n3\\n', async () => {
    const h = makeIO(['seq', '3']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n');
  });

  test('seq 2 5', async () => {
    const h = makeIO(['seq', '2', '5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('2\n3\n4\n5\n');
  });

  test('seq 1 2 10', async () => {
    const h = makeIO(['seq', '1', '2', '10']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n3\n5\n7\n9\n');
  });

  test('seq descending', async () => {
    const h = makeIO(['seq', '5', '-1', '1']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('5\n4\n3\n2\n1\n');
  });

  test('-s sets separator', async () => {
    const h = makeIO(['seq', '-s', ' ', '1', '3']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1 2 3\n');
  });

  test('-w equal width padding', async () => {
    const h = makeIO(['seq', '-w', '8', '10']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('08\n09\n10\n');
  });

  test('-f format', async () => {
    const h = makeIO(['seq', '-f', '%05.1f', '1', '3']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('001.0\n002.0\n003.0\n');
  });

  test('no args exits 1', async () => {
    const h = makeIO(['seq']);
    expect(await seqCommand(h.io)).toBe(1);
  });

  test('zero step exits 1', async () => {
    const h = makeIO(['seq', '1', '0', '5']);
    expect(await seqCommand(h.io)).toBe(1);
  });

  test('empty range (first > last) exits 1', async () => {
    const h = makeIO(['seq', '5', '1']);
    expect(await seqCommand(h.io)).toBe(1);
  });

  test('large count is complete + correct (CoalescingWriter buffers, not per-line)', async () => {
    // Guards the CoalescingWriter conversion: a per-line `await writer.write()`
    // parks on the pipe flush timer (~one line/tick) — hundreds of seconds for
    // 20k lines. This must produce all 20000 lines quickly and correctly.
    const h = makeIO(['seq', '1', '20000']);
    expect(await seqCommand(h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).toBe('1');
    expect(lines[19999]).toBe('20000');
    expect(lines[20000]).toBe(''); // trailing newline
    expect(lines.length).toBe(20001);
  });

  test('a downstream that closes early (EPIPE) stops seq with exit 0 (SIGPIPE-like)', async () => {
    // stdout errors after the first write (broken pipe / `seq … | head`). seq must
    // stop cleanly (exit 0), not surface a spurious error or hang.
    let writes = 0;
    const stdin = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    const stdout = new WritableStream<Uint8Array>({
      write() { writes++; throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }); },
    });
    const stderr = new WritableStream<Uint8Array>({ write() { /* ignore */ } });
    const io = { args: ['seq', '1', '100000'], env: {}, cwd: '/', stdin, stdout, stderr, syscall: async () => ({}) } as CommandIO;
    expect(await seqCommand(io)).toBe(0);
    expect(writes).toBeGreaterThan(0);
  });
});

describe('applySeqFormat', () => {
  test('%f', () => expect(applySeqFormat('%f', 1)).toBe('1.000000'));
  test('%05.1f', () => expect(applySeqFormat('%05.1f', 2)).toBe('002.0'));
  test('%g', () => expect(applySeqFormat('%g', 3.14)).toMatch('3.14'));
  test('%%', () => expect(applySeqFormat('%%', 0)).toBe('%'));
  test('literal text', () => expect(applySeqFormat('n=%d', 7)).toBe('n=7'));
});
