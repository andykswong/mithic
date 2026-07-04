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
    // x1 (natural cell 3) is padded to 4 to align with the same-size `c` type's
    // 4-wide cells (GNU cross-type column alignment).
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-t', 'c', '/in'], files: { '/in': 'ABCD' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      '000000  41  42  43  44\n' +
      '         A   B   C   D\n' +
      '000004\n',
    );
  });

  test('od -t x1 with -c combines (the -c flag is a c type at its position)', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-c', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      '000000  41  42\n' +
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
    expect(h.err()).toBe('od: option requires an argument -- \'t\'\nTry \'od --help\' for more information.\n');
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

  // ── GNU parity: default type o2, short type flags, 4-byte + float types ──

  test('the default type is o2 (2-byte octal words), NOT o1', async () => {
    const h = makeIO({ args: ['od', '/in'], files: { '/in': 'ABCD' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe('0000000 041101 042103\n0000004\n');
  });

  test('-x is hex 2-byte words (x2)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-x', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 4241 4443\n');
  });

  test('-d is unsigned 2-byte words (u2)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-d', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 16961 17475\n');
  });

  test('-o is octal 2-byte words (o2)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-o', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 041101 042103\n');
  });

  test('-i is signed 4-byte decimal (d4)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-i', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('  1145258561\n');
  });

  test('-b is octal bytes (o1)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-b', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 101 102\n');
  });

  test('-t x4 is 4-byte little-endian hex words', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x4', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 44434241\n');
  });

  test('-t d4 is 4-byte signed decimal', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'd4', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('  1145258561\n');
  });

  test('-f / -t f4 is single-precision float (shortest round-trip, width 15)', async () => {
    // 0x3f800000 LE = bytes 00 00 80 3f = 1.0
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'f4', '/in'], files: { '/in': new Uint8Array([0x00, 0x00, 0x80, 0x3f]) } });
    await odCommand(h.io);
    expect(h.out()).toBe('               1\n');
  });

  test('-t f4 renders scientific notation with a 2-digit-padded exponent', async () => {
    // 0x00000001 LE = smallest positive float32; the shortest round-trip is `1e-45`.
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'f4', '/in'], files: { '/in': new Uint8Array([0x01, 0x00, 0x00, 0x00]) } });
    await odCommand(h.io);
    expect(h.out().trim()).toBe('1e-45');
  });

  test('-t f4 pads a scientific exponent to 2 digits (e-8 → e-08)', async () => {
    // 0x33000000 LE = bytes 00 00 00 33 ≈ 2.98e-8 → GNU prints `e-08` (2 digits).
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'f4', '/in'], files: { '/in': new Uint8Array([0x00, 0x00, 0x00, 0x33]) } });
    await odCommand(h.io);
    expect(h.out().trim()).toBe('2.9802322e-08');
  });

  // ── GNU parity: cross-type column alignment ──

  test('same-size types share a per-cell width (x1 padded to align with c)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x1', '-c', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('  41  42  43  44\n   A   B   C   D\n');
  });

  test('mixed sizes align by group (x1 group left-padded to match o2)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x1', '-t', 'o2', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('  41 42  43 44\n 041101 042103\n');
  });

  // GNU parity: a 2-byte hex type combined with a 4-byte type gives each x2 datum
  // its own column width (NOT a packed pair left-padded as a group).
  test('-t x2 -t d4 aligns each 2-byte datum in its own column (GNU)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x2', '-t', 'd4', '/in'], files: { '/in': 'hello wo' } });
    await odCommand(h.io);
    expect(h.out()).toBe('  6568  6c6c  206f  6f77\n  1819043176  1870078063\n');
  });

  test('-t x2 -t f8 distributes the pad across the x2 fields (7,6,6,6 per group)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x2', '-t', 'f8', '/in'], files: { '/in': new Uint8Array(16).map((_, i) => i) } });
    await odCommand(h.io);
    const x2Line = h.out().split('\n')[0];
    // Four 2-byte fields per 8-byte group, cumulative-ceil widths: 7,6,6,6.
    expect(x2Line).toBe('   0100  0302  0504  0706   0908  0b0a  0d0c  0f0e');
  });

  // ── GNU parity: -e / -F double-float aliases ──

  test('-e is an alias for -t fD (double)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-e'], stdinText: 'hello wo' });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out().trim()).toBe('8.765776478827897e+228');
  });

  test('-F is an alias for -t fD (double)', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-F'], stdinText: 'hello wo' });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out().trim()).toBe('8.765776478827897e+228');
  });

  // ── GNU parity: `z` type suffix (append printable-ASCII display) ──

  test('-t x1z appends the printable-ASCII display', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x1z', '/in'], files: { '/in': 'hello world!' } });
    await odCommand(h.io);
    expect(h.out()).toBe(' 68 65 6c 6c 6f 20 77 6f 72 6c 64 21              >hello world!<\n');
  });

  test('-t x1z renders non-printable bytes as . in the display', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'cz', '/in'], files: { '/in': 'hi\tbye\n' } });
    await odCommand(h.io);
    expect(h.out()).toContain('>hi.bye.<');
  });

  test('z applies per-spec: only the z-tagged type carries the display', async () => {
    const h = makeIO({ args: ['od', '-A', 'n', '-t', 'x1z', '-t', 'd4', '/in'], files: { '/in': 'hello world!' } });
    await odCommand(h.io);
    const lines = h.out().split('\n');
    expect(lines[0]).toContain('>hello world!<');
    expect(lines[1]).not.toContain('>'); // the d4 line has no display
  });

  // ── GNU parity: -N / -j / -v / -w ──

  test('-N limits the number of bytes dumped', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-N', '4', '/in'], files: { '/in': 'ABCDEFGH' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 41 42 43 44\n000004\n');
  });

  test('-j skips bytes and offsets stay absolute', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-j', '2', '/in'], files: { '/in': 'ABCD' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000002 43 44\n000004\n');
  });

  test('-j past end errors and exits 1', async () => {
    const h = makeIO({ args: ['od', '-j', '99', '/in'], files: { '/in': 'ABCD' } });
    expect(await odCommand(h.io)).toBe(1);
    expect(h.err()).toBe('od: cannot skip past end of combined input\n');
  });

  test('-w8 sets 8 bytes per output line', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-w8', '/in'], files: { '/in': '0123456789' } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 30 31 32 33 34 35 36 37\n' +
      '000008 38 39\n' +
      '00000a\n',
    );
  });

  test('-w0 is an invalid width (exit 1)', async () => {
    const h = makeIO({ args: ['od', '-w0', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(1);
    expect(h.err()).toBe('od: invalid -w argument \'0\'\n');
  });

  test('-v disables duplicate-line elision', async () => {
    const h = makeIO({ args: ['od', '-A', 'x', '-t', 'x1', '-v', '/in'], files: { '/in': new Uint8Array(32).fill(0) } });
    await odCommand(h.io);
    expect(h.out()).toBe(
      '000000 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n' +
      '000010 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n' +
      '000020\n',
    );
  });

  test('an invalid address radix errors with the GNU message', async () => {
    const h = makeIO({ args: ['od', '-A', 'z', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(1);
    expect(h.err()).toBe('od: invalid output address radix \'z\'; it must be one character from [doxn]\n');
  });

  // ── M8: -a named-ASCII masks high bytes to the low-7-bit name/char ──

  test('-a renders bytes >= 0x80 as the masked low-7-bit ASCII name/char', async () => {
    // 0x80&0x7f=0x00 → nul, 0xff&0x7f=0x7f → del, 0xe0&0x7f=0x60 → `
    const h = makeIO({ args: ['od', '-A', 'n', '-a', '/in'], files: { '/in': new Uint8Array([0x80, 0xff, 0xe0]) } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe(' nul del   `\n');
  });

  test('-a masks a high printable byte to its low-7-bit character', async () => {
    // 0xc1 & 0x7f = 0x41 → 'A'; 0xfe & 0x7f = 0x7e → '~'
    const h = makeIO({ args: ['od', '-A', 'n', '-a', '/in'], files: { '/in': new Uint8Array([0xc1, 0xfe]) } });
    await odCommand(h.io);
    expect(h.out()).toBe('   A   ~\n');
  });

  // ── L12: -A / --address-radix reads only the FIRST char of its argument ──

  test('-A reads only the first char of a multi-char radix argument', async () => {
    // GNU `od -Anone` → radix n (first char of "none"); no address column.
    const h = makeIO({ args: ['od', '-Anone', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(0);
    expect(h.out()).toBe(' 41 42\n');
  });

  test('--address-radix=xyz uses only the first char (x)', async () => {
    const h = makeIO({ args: ['od', '--address-radix=xyz', '-t', 'x1', '/in'], files: { '/in': 'AB' } });
    await odCommand(h.io);
    expect(h.out()).toBe('000000 41 42\n000002\n');
  });

  test('-A with an invalid first char quotes only the first char', async () => {
    const h = makeIO({ args: ['od', '-Azzz', '/in'], files: { '/in': 'AB' } });
    expect(await odCommand(h.io)).toBe(1);
    expect(h.err()).toBe('od: invalid output address radix \'z\'; it must be one character from [doxn]\n');
  });
});
