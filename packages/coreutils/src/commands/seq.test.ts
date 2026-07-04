import { expect, test, describe } from 'vitest';
import { seqCommand } from './seq.ts';
import { applySeqFormat, fractionalDigits, parseSeqNumber } from './seq.ts';
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

  test('no args exits 1 (missing operand)', async () => {
    const h = makeIO(['seq']);
    expect(await seqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('missing operand');
  });

  test('zero step exits 1', async () => {
    const h = makeIO(['seq', '1', '0', '5']);
    expect(await seqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('Zero increment');
  });

  test('empty range (first > last) prints nothing but exits 0 (GNU parity)', async () => {
    const h = makeIO(['seq', '5', '1']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('descending step, empty range still exits 0', async () => {
    const h = makeIO(['seq', '1', '-1', '5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('invalid number exits 1', async () => {
    const h = makeIO(['seq', 'abc']);
    expect(await seqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid floating point argument');
  });

  test('extra operand exits 1', async () => {
    const h = makeIO(['seq', '1', '2', '3', '4']);
    expect(await seqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('extra operand');
  });

  test('-w with -f is an error (exit 1)', async () => {
    const h = makeIO(['seq', '-w', '-f', '%g', '1', '3']);
    expect(await seqCommand(h.io)).toBe(1);
    expect(h.err()).toContain('may not be specified when printing equal width');
  });

  // ── GNU-parity gap fixes ─────────────────────────────────────────────────────

  test('BigInt integer path past 2^53 stays exact (no float corruption, no hang)', async () => {
    const h = makeIO(['seq', '9007199254740992', '9007199254740994']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('9007199254740992\n9007199254740993\n9007199254740994\n');
  });

  test('very large integers (> Number.MAX_SAFE) exact via BigInt', async () => {
    const h = makeIO(['seq', '100000000000000000000', '100000000000000000002']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('100000000000000000000\n100000000000000000001\n100000000000000000002\n');
  });

  test('decimal path avoids binary-float drift (0.1 step)', async () => {
    const h = makeIO(['seq', '0.1', '0.1', '0.5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0.1\n0.2\n0.3\n0.4\n0.5\n'); // not 0.30000000000000004
  });

  test('trailing .0 precision preserved (seq 1.0 3.0)', async () => {
    const h = makeIO(['seq', '1.0', '3.0']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1.0\n2.0\n3.0\n');
  });

  test('precision is max fractional digits of operands (step .25)', async () => {
    const h = makeIO(['seq', '1', '0.25', '2']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1.00\n1.25\n1.50\n1.75\n2.00\n');
  });

  test('scientific notation operand (1e2 → 1..100)', async () => {
    const h = makeIO(['seq', '1e2']);
    expect(await seqCommand(h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).toBe('1');
    expect(lines[99]).toBe('100');
    expect(lines[100]).toBe('');
  });

  test('scientific precision (1.25e1 → 12.5, one decimal)', async () => {
    const h = makeIO(['seq', '1.25e1', '20']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('12.5\n13.5\n14.5\n15.5\n16.5\n17.5\n18.5\n19.5\n');
  });

  test('-f %g drops nothing at endpoints', async () => {
    const h = makeIO(['seq', '-f', '%g', '1', '3']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n');
  });

  test('-w fractional keeps precision AND pads (0.5 step)', async () => {
    const h = makeIO(['seq', '-w', '0.5', '0.5', '2.5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0.5\n1.0\n1.5\n2.0\n2.5\n');
  });

  test('-w negative float: sign kept before zero pad', async () => {
    const h = makeIO(['seq', '-w', '-1.5', '0.5', '1.5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-1.5\n-1.0\n-0.5\n00.0\n00.5\n01.0\n01.5\n');
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

  // ── CR2 parity fixes: -f sign flags, hex operands, precision from FIRST/STEP ─

  test('-f honors + sign flag (%+.1f)', async () => {
    const h = makeIO(['seq', '-f', '%+.1f', '1', '2']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('+1.0\n+2.0\n');
  });

  test('-f honors space sign flag (% .1f)', async () => {
    const h = makeIO(['seq', '-f', '% .1f', '1', '2']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe(' 1.0\n 2.0\n');
  });

  test('-f + with zero-pad: sign consumes one column (%+05.1f)', async () => {
    const h = makeIO(['seq', '-f', '%+05.1f', '1', '2']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('+01.0\n+02.0\n');
  });

  test('-f + with left-align width (%-+6.1f|)', async () => {
    const h = makeIO(['seq', '-f', '%-+6.1f|', '1', '2']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('+1.0  |\n+2.0  |\n');
  });

  test('-f + on a negative value keeps the minus (and +0.0)', async () => {
    const h = makeIO(['seq', '-f', '%+.1f', '-2', '1', '0']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-2.0\n-1.0\n+0.0\n');
  });

  test('hex integer operand (seq 0x10 → 1..16)', async () => {
    const h = makeIO(['seq', '0x10']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n');
  });

  test('hex step operand (seq 1 0x10 32 → 1,17)', async () => {
    const h = makeIO(['seq', '1', '0x10', '32']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n17\n');
  });

  test('hex float operand with binary exponent (seq 0x1.8p1 → 1,2,3)', async () => {
    const h = makeIO(['seq', '0x1.8p1']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n');
  });

  test('precision comes from FIRST/STEP only, not LAST (seq 2.5e0 → 1,2)', async () => {
    const h = makeIO(['seq', '2.5e0']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n');
  });

  test('fractional LAST does not add precision (seq 3.9 → 1,2,3)', async () => {
    const h = makeIO(['seq', '3.9']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n3\n');
  });

  test('integer FIRST/STEP with fractional LAST prints integers (seq 1 2.5 → 1,2)', async () => {
    const h = makeIO(['seq', '1', '2.5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n');
  });

  test('fractional FIRST still sets precision (seq 0.5 2.5)', async () => {
    const h = makeIO(['seq', '0.5', '2.5']);
    expect(await seqCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0.5\n1.5\n2.5\n');
  });
});

describe('applySeqFormat', () => {
  test('%f', () => expect(applySeqFormat('%f', 1)).toBe('1.000000'));
  test('%05.1f', () => expect(applySeqFormat('%05.1f', 2)).toBe('002.0'));
  test('%g', () => expect(applySeqFormat('%g', 3.14)).toMatch('3.14'));
  test('%%', () => expect(applySeqFormat('%%', 0)).toBe('%'));
  test('literal text', () => expect(applySeqFormat('n=%d', 7)).toBe('n=7'));
  test('%e two-digit exponent', () => expect(applySeqFormat('%e', 1000000)).toBe('1.000000e+06'));
  test('%+.1f positive sign', () => expect(applySeqFormat('%+.1f', 1)).toBe('+1.0'));
  test('% .1f space sign', () => expect(applySeqFormat('% .1f', 1)).toBe(' 1.0'));
  test('%+.1f negative keeps minus', () => expect(applySeqFormat('%+.1f', -1)).toBe('-1.0'));
  test('%+05.1f sign takes a column', () => expect(applySeqFormat('%+05.1f', 1)).toBe('+01.0'));
  test('%+05.1f negative zero-pad after minus', () => expect(applySeqFormat('%+05.1f', -1)).toBe('-01.0'));

  // ── M2: round-half-to-EVEN for %f/%e/%E (matches GNU/C, not JS toFixed) ──
  test('%.0f 2.5 → 2 (tie to even)', () => expect(applySeqFormat('%.0f', 2.5)).toBe('2'));
  test('%.0f 3.5 → 4 (tie to even)', () => expect(applySeqFormat('%.0f', 3.5)).toBe('4'));
  test('%.0f -2.5 → -2 (tie to even)', () => expect(applySeqFormat('%.0f', -2.5)).toBe('-2'));
  test('%.0f 0.5 → 0 (tie to even)', () => expect(applySeqFormat('%.0f', 0.5)).toBe('0'));
  test('%.1f 0.25 → 0.2 (tie to even)', () => expect(applySeqFormat('%.1f', 0.25)).toBe('0.2'));
  test('%.0f 1.5 → 2 (non-boundary still correct)', () => expect(applySeqFormat('%.0f', 1.5)).toBe('2'));
  test('%.0f 2.4 → 2 (non-tie down)', () => expect(applySeqFormat('%.0f', 2.4)).toBe('2'));
  test('%.0f 2.6 → 3 (non-tie up)', () => expect(applySeqFormat('%.0f', 2.6)).toBe('3'));
  test('%f default 6 digits still correct', () => expect(applySeqFormat('%f', 2.5)).toBe('2.500000'));
  test('%.0e 2.5 → 2e+00 (tie to even)', () => expect(applySeqFormat('%.0e', 2.5)).toBe('2e+00'));
  test('%.3e 12345 → 1.234e+04 (tie to even)', () => expect(applySeqFormat('%.3e', 12345)).toBe('1.234e+04'));
  test('%e exponent zero-padding preserved', () => expect(applySeqFormat('%e', 1000000)).toBe('1.000000e+06'));
  test('%.0g 2.5 → 2 (tie to even)', () => expect(applySeqFormat('%.0g', 2.5)).toBe('2'));

  // ── L2: %g/%G C rules — scientific when exp < -4 or >= precision, strip zeros ──
  test('%g 1000000 → 1e+06', () => expect(applySeqFormat('%g', 1000000)).toBe('1e+06'));
  test('%g 0.00001 → 1e-05', () => expect(applySeqFormat('%g', 0.00001)).toBe('1e-05'));
  test('%.3g 12345 → 1.23e+04', () => expect(applySeqFormat('%.3g', 12345)).toBe('1.23e+04'));
  test('%g 100000 stays fixed', () => expect(applySeqFormat('%g', 100000)).toBe('100000'));
  test('%g 0.0001 stays fixed', () => expect(applySeqFormat('%g', 0.0001)).toBe('0.0001'));
  test('%g strips trailing zeros (1.5)', () => expect(applySeqFormat('%g', 1.5)).toBe('1.5'));
  test('%g integer value (3)', () => expect(applySeqFormat('%g', 3)).toBe('3'));
  test('%G uppercases exponent', () => expect(applySeqFormat('%G', 1000000)).toBe('1E+06'));
});

describe('parseSeqNumber', () => {
  test('decimal', () => expect(parseSeqNumber('1.5')).toBe(1.5));
  test('scientific', () => expect(parseSeqNumber('2.5e0')).toBe(2.5));
  test('hex integer', () => expect(parseSeqNumber('0x10')).toBe(16));
  test('negative hex integer', () => expect(parseSeqNumber('-0xA')).toBe(-10));
  test('hex float 0x1p4', () => expect(parseSeqNumber('0x1p4')).toBe(16));
  test('hex float 0x1.8p1', () => expect(parseSeqNumber('0x1.8p1')).toBe(3));
});

describe('fractionalDigits', () => {
  test('integer → 0', () => expect(fractionalDigits('100')).toBe(0));
  test('one decimal', () => expect(fractionalDigits('1.0')).toBe(1));
  test('two decimals', () => expect(fractionalDigits('0.25')).toBe(2));
  test('.5 → 1', () => expect(fractionalDigits('.5')).toBe(1));
  test('scientific 1.25e1 → 1', () => expect(fractionalDigits('1.25e1')).toBe(1));
  test('scientific 1.5e1 → 0', () => expect(fractionalDigits('1.5e1')).toBe(0));
  test('scientific 1e-1 → 1', () => expect(fractionalDigits('1e-1')).toBe(1));
  test('scientific 1e2 → 0', () => expect(fractionalDigits('1e2')).toBe(0));
});
