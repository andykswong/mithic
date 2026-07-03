import { expect, test, describe } from 'vitest';
import { foldCommand, foldLine, foldBytes } from './fold.ts';
import { makeIO } from './_test-io.ts';

describe('fold', () => {
  test('-w wraps at width', async () => {
    const h = makeIO({ args: ['fold', '-w', '3'], stdinText: 'abcdefg\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\ndef\ng\n');
  });

  test('lines shorter than width are unchanged', async () => {
    const h = makeIO({ args: ['fold', '-w', '10'], stdinText: 'short\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('short\n');
  });

  test('-s breaks at spaces', async () => {
    const h = makeIO({ args: ['fold', '-w', '10', '-s'], stdinText: 'hello world foo\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('hello \nworld foo\n');
  });

  test('default width 80', async () => {
    const long = 'x'.repeat(85);
    const h = makeIO({ args: ['fold'], stdinText: long + '\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('x'.repeat(80) + '\n' + 'x'.repeat(5) + '\n');
  });

  test('reads a file', async () => {
    const h = makeIO({ args: ['fold', '-w', '2', '/a'], files: { '/a': 'abcd\n' } });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ab\ncd\n');
  });

  test('invalid width errors', async () => {
    const h = makeIO({ args: ['fold', '-w', '0'], stdinText: 'x\n' });
    expect(await foldCommand(h.io)).toBe(1);
    expect(h.err()).toContain('invalid');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['fold', '/missing'] });
    expect(await foldCommand(h.io)).toBe(1);
    expect(h.err()).toContain('fold: /missing:');
  });

  // ── obsolete -N width ─────────────────────────────────────────────────────

  test('obsolete -N is treated as -w N', async () => {
    const h = makeIO({ args: ['fold', '-3'], stdinText: 'abcdefg\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abc\ndef\ng\n');
  });

  test('obsolete -N combines with -s', async () => {
    const h = makeIO({ args: ['fold', '-3', '-s'], stdinText: 'ab cd ef\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ab \ncd \nef\n');
  });

  test('obsolete -bN combines byte mode + width', async () => {
    const h = makeIO({ args: ['fold', '-b3'], stdinText: 'café\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('caf\né\n');
  });

  // ── char-mode column semantics ────────────────────────────────────────────

  test('tab advances to the next multiple of 8', async () => {
    const h = makeIO({ args: ['fold', '-w', '3'], stdinText: '12\t3\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('12\n\t\n3\n');
  });

  test('backspace decrements the column', async () => {
    const h = makeIO({ args: ['fold', '-w', '2'], stdinText: 'ab\bc\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ab\bc\n');
  });

  test('carriage return resets the column', async () => {
    const h = makeIO({ args: ['fold', '-w', '3'], stdinText: 'a\rbcdef\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\rbcd\nef\n');
  });

  test('wide CJK chars count as 2 columns', async () => {
    const h = makeIO({ args: ['fold', '-w', '2'], stdinText: '你好\n' });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('你\n好\n');
  });

  // ── -b byte mode with multibyte ───────────────────────────────────────────

  test('-b measures multibyte by byte length but never splits a char', async () => {
    const h = makeIO({ args: ['fold', '-b', '-w', '2'], stdinText: 'café\n' });
    expect(await foldCommand(h.io)).toBe(0);
    // c a | f | é(2 bytes) — the multibyte char stays whole
    expect(h.out()).toBe('ca\nf\né\n');
  });

  test('-b reads a file byte-exactly', async () => {
    const h = makeIO({ args: ['fold', '-b', '-w', '2', '/f'], files: { '/f': 'café\n' } });
    expect(await foldCommand(h.io)).toBe(0);
    expect(h.out()).toBe('ca\nf\né\n');
  });

  // ── unknown-flag reject ────────────────────────────────────────────────────

  test('unknown flag → invalid option, exit 1', async () => {
    const h = makeIO({ args: ['fold', '-Z'], stdinText: 'x\n' });
    expect(await foldCommand(h.io)).toBe(1);
    expect(h.err()).toBe('fold: invalid option -- \'Z\'\nTry \'fold --help\' for more information.\n');
  });

  describe('foldLine / foldBytes', () => {
    test('hard wrap', () => { expect(foldLine('abcdef', 2, false)).toBe('ab\ncd\nef'); });
    test('space wrap', () => { expect(foldLine('ab cd ef', 4, true)).toBe('ab \ncd \nef'); });
    test('byte mode never splits a multibyte char', () => {
      const bytes = foldBytes('café', 2, false, true);
      expect(new TextDecoder().decode(bytes)).toBe('ca\nf\né');
    });
    test('char mode wide chars', () => { expect(foldLine('你好', 2, false)).toBe('你\n好'); });

    // ── -s breaks AFTER a blank at/before the width boundary (GNU parity) ────
    test('-s keeps a blank that lands exactly on the width boundary', () => {
      // 'ab  cd' width 4: the two trailing blanks fill columns 3-4, so the line
      // is `ab  ` (4 chars) — NOT `ab ` (an earlier off-by-one broke one too soon).
      expect(foldLine('ab  cd', 4, true)).toBe('ab  \ncd');
    });
    test('-s breaks after the last fitting blank, not the previous one', () => {
      // width 9: `d dc  dc ` (9 chars incl. the trailing space) then `ab c`.
      expect(foldLine('d dc  dc ab c', 9, true)).toBe('d dc  dc \nab c');
    });
    test('-s single word longer than width still hard-breaks', () => {
      expect(foldLine('abcdef', 3, true)).toBe('abc\ndef');
    });
  });
});
