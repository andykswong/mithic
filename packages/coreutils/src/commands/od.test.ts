import { expect, test, describe } from 'vitest';
import { odCommand } from './od.ts';
import { makeIO } from './_testio.ts';

describe('od', () => {
  // Expected strings are GNU coreutils `od` output (the reference the command
  // targets — see od.ts header). BSD/macOS od spaces columns differently.
  test('-A x -t x1 of "AB"', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });

  test('-A x -t x1 wraps at 16 bytes per line', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': '0123456789ABCDEFG' } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 30 31 32 33 34 35 36 37 38 39 41 42 43 44 45 46\n' +
      '000010 47\n' +
      '000011\n',
    );
  });

  test('-c of "A\\nB" (default octal address)', async () => {
    const h = makeIO({ args: ['od', '-c', '/in'], files: { '/in': 'A\nB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0000000   A  \\n   B\n0000003\n');
  });

  test('-A d decimal address radix', async () => {
    const h = makeIO({ args: ['od', '-A', 'd', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe('0000000 41 42\n0000002\n');
  });

  test('-A n suppresses the address column', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 41 42\n');
  });

  test('-t o1 octal bytes', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'o1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 101 102\n000002\n');
  });

  test('reads stdin when no file operand', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1'], stdinText: 'AB' });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });

  test('empty input prints just the final address', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': '' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000\n');
  });

  // --- C2: multi-byte type widths (2-byte little-endian words on a LE host) ---

  test('-t x2 dumps 2-byte little-endian words', async () => {
    // bytes 0x41 0x42 0x43 0x44 → LE words 0x4241 0x4443 → " 4241 4443"
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x2', '/in'], files: { '/in': 'ABCD' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('000000 4241 4443\n000004\n');
  });

  test('-t x2 pads an odd trailing byte into a high-zero word', async () => {
    // 3 bytes 0x41 0x42 0x43 → words 0x4241, 0x0043 → " 4241 0043"
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x2', '/in'], files: { '/in': 'ABC' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 4241 0043\n000003\n');
  });

  test('-t o2 dumps 2-byte octal words (6 octal digits)', async () => {
    // words 0x4241=041101, 0x4443=042103
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'o2', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 041101 042103\n000004\n');
  });

  test('-t d2 dumps signed 16-bit decimal words (width 6)', async () => {
    // words 0x4241=16961, 0x4443=17475 → "  16961  17475"
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'd2', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000  16961  17475\n000004\n');
  });

  test('-t d2 renders negative words', async () => {
    // bytes 0xFF 0xFF → -1; 0x00 0x80 → -32768
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'd2', '/in'], files: { '/in': new Uint8Array([0xff, 0xff, 0x00, 0x80]) } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000     -1 -32768\n000004\n');
  });

  test('-t x2 wraps at 16 bytes (8 words) per line', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x2', '/in'], files: { '/in': new Uint8Array(18).fill(0) } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 0000 0000 0000 0000 0000 0000 0000 0000\n' +
      '000010 0000\n' +
      '000012\n',
    );
  });

  // --- C2: `*` duplicate-line elision (GNU) ---

  test('-t x1 elides duplicate lines with *', async () => {
    // 48 identical bytes (3 full 16-byte lines) → first line, then `*`, then the final offset.
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': new Uint8Array(48).fill(0) } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n' +
      '*\n' +
      '000030\n',
    );
  });

  test('-t x1 resumes printing at the first differing line after elision', async () => {
    // 32 zero bytes (offsets 0x00, 0x10 — the second elided) then 16 0xFF bytes at 0x20.
    const data = new Uint8Array(48);
    data.fill(0xff, 32);
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': data } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n' +
      '*\n' +
      '000020 ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff\n' +
      '000030\n',
    );
  });

  // --- C1: combining MULTIPLE -t specs (one line per type per block, GNU) ---

  test('od combines multiple -t specs (one line per type, blanked continuation address)', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-t', 'c', '/in'], files: { '/in': 'ABCD' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      '000000 41 42 43 44\n' +
      '         A   B   C   D\n' +
      '000004\n',
    );
  });

  test('od -t x1 with -c combines (the -c flag is a c type at its position)', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-c', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      '000000 41 42\n' +
      '         A   B\n' +
      '000002\n',
    );
  });

  test('od multi-type * elision compares the full block', async () => {
    // 48 identical bytes (0x41) → block repeats; first block prints both type lines,
    // then a bare `*`, then the final offset.
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-t', 'c', '/in'], files: { '/in': 'A'.repeat(48) } });
    expect(await odCommand(h.io)).toBe(0);
    const out = h.out();
    expect(out).toContain('*\n');
    expect(out.endsWith('000030\n')).toBe(true); // 48 = 0x30
  });

  // --- FIX 3: type-scan stops at `--`, errors on a dangling `-t` ---

  test('a dangling -t (no following spec) errors like GNU and exits 1', async () => {
    // GNU: `od: option requires an argument -- 't'` (exit 1). We must NOT silently
    // default to o1 when -t is the final argument.
    const h = makeIO({ args: ['od', '-t'] });
    expect(await odCommand(h.io)).toBe(1);
    expect(h.err()).toBe('od: option requires an argument -- \'t\'\n');
  });

  test('-t x1 followed by other args is unaffected', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });

  test('type-scan stops at `--`; a later -tTYPE-looking token is a filename', async () => {
    // After `--`, tokens are filenames, not type specs. `-t x1` here is a real
    // type spec; `--` ends option scanning so the operand `/in` is the file.
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '--', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });
});
