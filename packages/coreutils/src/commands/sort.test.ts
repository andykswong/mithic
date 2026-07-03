import { expect, test, describe } from 'vitest';
import { sortCommand, parseKey, KeyError } from './sort.ts';
import { makeIO } from './_test-io.ts';

describe('sort', () => {
  test('lexicographic sort', async () => {
    const h = makeIO({ args: ['sort'], stdinText: 'banana\napple\ncherry\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('apple\nbanana\ncherry\n');
  });

  test('-n numeric sort', async () => {
    const h = makeIO({ args: ['sort', '-n'], stdinText: '10\n2\n1\n20\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1\n2\n10\n20\n');
  });

  test('-r reverse', async () => {
    const h = makeIO({ args: ['sort', '-r'], stdinText: 'a\nb\nc\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c\nb\na\n');
  });

  test('-u unique', async () => {
    const h = makeIO({ args: ['sort', '-u'], stdinText: 'b\na\nb\na\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\n');
  });

  test('-f fold case', async () => {
    const h = makeIO({ args: ['sort', '-f'], stdinText: 'Banana\napple\nCherry\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('apple\nBanana\nCherry\n');
  });

  test('-k key with -t separator', async () => {
    const h = makeIO({ args: ['sort', '-t', ':', '-k', '2', '-n'], stdinText: 'a:3\nb:1\nc:2\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('b:1\nc:2\na:3\n');
  });

  test('-k2,2n per-key numeric', async () => {
    const h = makeIO({ args: ['sort', '-t', ',', '-k2,2n'], stdinText: 'x,10\ny,2\nz,1\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('z,1\ny,2\nx,10\n');
  });

  test('-b ignores leading blanks', async () => {
    const h = makeIO({ args: ['sort', '-b'], stdinText: '   b\n a\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe(' a\n   b\n');
  });

  test('stable for equal keys', async () => {
    const h = makeIO({ args: ['sort', '-k', '1,1'], stdinText: 'a first\na second\na third\n' });
    expect(await sortCommand(h.io)).toBe(0);
    // GNU last-resort compares whole lines, so this orders them; verify deterministic
    expect(h.out()).toBe('a first\na second\na third\n');
  });

  test('multiple files concatenated and sorted', async () => {
    const h = makeIO({ args: ['sort', '/a', '/b'], files: { '/a': 'c\na\n', '/b': 'b\n' } });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\nb\nc\n');
  });

  test('empty input yields nothing', async () => {
    const h = makeIO({ args: ['sort'], stdinText: '' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
  });

  test('missing file errors and exits 1', async () => {
    const h = makeIO({ args: ['sort', '/missing'] });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.err()).toContain('sort:');
  });

  test('-k2,2r per-key reverse', async () => {
    const h = makeIO({ args: ['sort', '-t', ',', '-k2,2r'], stdinText: 'x,a\ny,c\nz,b\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('y,c\nz,b\nx,a\n');
  });

  test('multiple -k keys applied in order', async () => {
    const h = makeIO({ args: ['sort', '-t', ',', '-k1,1', '-k2,2n'], stdinText: 'b,2\na,10\na,2\nb,1\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a,2\na,10\nb,1\nb,2\n');
  });

  test('per-key numeric with reverse on second key', async () => {
    const h = makeIO({ args: ['sort', '-t', ',', '-k1,1', '-k2,2nr'], stdinText: 'a,1\na,3\na,2\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a,3\na,2\na,1\n');
  });

  test('end column .C limits the key span', async () => {
    // `-k1.2,1.2r`: the key is ONLY the 2nd char (both 'a'), so they tie on the
    // key and fall back to ascending whole-line order. Contrast with `-k1.2r`
    // (next test) whose key runs to end-of-field and so differs.
    const h = makeIO({ args: ['sort', '-k1.2,1.2r'], stdinText: 'xab\nxaa\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xaa\nxab\n');
  });

  test('without end column the key runs to end of field', async () => {
    const h = makeIO({ args: ['sort', '-k1.2r'], stdinText: 'xab\nxaa\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('xab\nxaa\n');
  });

  test('missing file uses canonical errno text', async () => {
    const h = makeIO({ args: ['sort', '/missing'] });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.err()).toBe('sort: cannot read: /missing: No such file or directory\n');
  });

  // ── -h human numeric ──────────────────────────────────────────────────────
  test('-h human-readable numeric sort', async () => {
    const h = makeIO({ args: ['sort', '-h'], stdinText: '2K\n1M\n500\n3G\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('500\n2K\n1M\n3G\n');
  });

  test('-h with decimals and negatives', async () => {
    const h = makeIO({ args: ['sort', '-h'], stdinText: '-1K\n2K\n-3M\n0\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('-3M\n-1K\n0\n2K\n');
  });

  // ── -V version sort ───────────────────────────────────────────────────────
  test('-V version sort', async () => {
    const h = makeIO({ args: ['sort', '-V'], stdinText: 'v1.10\nv1.9\nv1.2\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('v1.2\nv1.9\nv1.10\n');
  });

  test('-V leading-zero ordering', async () => {
    const h = makeIO({ args: ['sort', '-V'], stdinText: '1.001\n1.01\n1.1\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('1.001\n1.01\n1.1\n');
  });

  test('-V numeric vs string runs', async () => {
    const h = makeIO({ args: ['sort', '-V'], stdinText: 'foo1\nfoo10\nfoo2\nfoo2a\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('foo1\nfoo2\nfoo2a\nfoo10\n');
  });

  // ── -M month sort ─────────────────────────────────────────────────────────
  test('-M month sort', async () => {
    const h = makeIO({ args: ['sort', '-M'], stdinText: 'Mar\nJan\nFeb\nDec\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('Jan\nFeb\nMar\nDec\n');
  });

  test('-M unknowns sort before months, then whole-line', async () => {
    const h = makeIO({ args: ['sort', '-M'], stdinText: 'foo\nJan\nbar\nDec\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('bar\nfoo\nJan\nDec\n');
  });

  // ── -g general numeric ────────────────────────────────────────────────────
  test('-g general numeric with scientific notation', async () => {
    const h = makeIO({ args: ['sort', '-g'], stdinText: '1e3\n5\n1.5e1\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('5\n1.5e1\n1e3\n');
  });

  test('-g orders nan < -inf < finite < inf', async () => {
    const h = makeIO({ args: ['sort', '-g'], stdinText: 'inf\n-inf\n0\nnan\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('nan\n-inf\n0\ninf\n');
  });

  // ── -c / -C check modes ───────────────────────────────────────────────────
  test('-c passes on sorted input (exit 0, no output)', async () => {
    const h = makeIO({ args: ['sort', '-c'], stdinText: 'a\nb\nc\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('');
  });

  test('-c reports first disorder and exits 1', async () => {
    const h = makeIO({ args: ['sort', '-c'], stdinText: 'b\na\n' });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('sort: -:2: disorder: a\n');
  });

  test('-c on a file names the file in the diagnostic', async () => {
    const h = makeIO({ args: ['sort', '-c', '/f'], files: { '/f': 'b\na\n' } });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.err()).toBe('sort: /f:2: disorder: a\n');
  });

  test('-C is quiet on disorder (exit 1, no message)', async () => {
    const h = makeIO({ args: ['sort', '-C'], stdinText: 'b\na\n' });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.err()).toBe('');
  });

  test('-c -u treats an equal adjacent pair as disorder', async () => {
    const h = makeIO({ args: ['sort', '-c', '-u'], stdinText: 'a\na\n' });
    expect(await sortCommand(h.io)).toBe(1);
    expect(h.err()).toBe('sort: -:2: disorder: a\n');
  });

  test('-c on equal adjacent pair without -u is ordered', async () => {
    const h = makeIO({ args: ['sort', '-c'], stdinText: 'a\na\nb\n' });
    expect(await sortCommand(h.io)).toBe(0);
  });

  // ── -u -k dedups by key only ──────────────────────────────────────────────
  test('-u -k dedups by the key, not the whole line', async () => {
    const h = makeIO({ args: ['sort', '-u', '-k1,1'], stdinText: 'a 1\na 2\nb 3\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a 1\nb 3\n');
  });

  // ── -z NUL delimiter ──────────────────────────────────────────────────────
  test('-z reads/writes NUL-delimited records', async () => {
    const h = makeIO({ args: ['sort', '-z'], stdinText: 'b\0a\0c\0' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a\0b\0c\0');
  });

  // ── -o output file ────────────────────────────────────────────────────────
  test('-o writes the sorted result to a file (stdout empty)', async () => {
    const h = makeIO({ args: ['sort', '-o', '/out', '/in'], files: { '/in': 'b\na\nc\n' } });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('');
    expect(h.file('/out')).toBe('a\nb\nc\n');
  });

  test('-o with a separate input operand (not misparsed as input)', async () => {
    const h = makeIO({ args: ['sort', '-o', '/out', '/in'], files: { '/in': 'z\ny\nx\n' } });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.file('/out')).toBe('x\ny\nz\n');
  });

  test('-k2,2h per-key human numeric', async () => {
    const h = makeIO({ args: ['sort', '-t', ' ', '-k2,2h'], stdinText: 'a 2K\nb 1M\nc 500\n' });
    expect(await sortCommand(h.io)).toBe(0);
    expect(h.out()).toBe('c 500\na 2K\nb 1M\n');
  });

  describe('parseKey', () => {
    test('field only', () => { expect(parseKey('2')).toMatchObject({ startField: 2, startChar: 1 }); });
    test('field.char with end+numeric', () => {
      expect(parseKey('2.3,4n')).toMatchObject({ startField: 2, startChar: 3, endField: 4, kind: 'numeric' });
    });
    test('per-key reverse flag', () => {
      expect(parseKey('2,2r')).toMatchObject({ startField: 2, endField: 2, reverse: true });
    });
    test('end char offset', () => {
      expect(parseKey('1.1,1.3')).toMatchObject({ startField: 1, startChar: 1, endField: 1, endChar: 3 });
    });
    test('zero field number throws with GNU diagnostic', () => {
      expect(() => parseKey('0')).toThrow(KeyError);
      expect(() => parseKey('0')).toThrow('field number is zero: invalid field specification ‘0’');
      expect(() => parseKey('1,0')).toThrow('field number is zero: invalid field specification ‘1,0’');
    });
    test('zero start char offset throws', () => {
      expect(() => parseKey('1.0')).toThrow('character offset is zero: invalid field specification ‘1.0’');
    });
    test('valid specs do not throw', () => {
      expect(() => parseKey('1')).not.toThrow();
      expect(() => parseKey('1.1')).not.toThrow();
      expect(() => parseKey('2,3')).not.toThrow();
      // An end char offset of `.0` (through end of field) is NOT an error.
      expect(() => parseKey('1,1.0')).not.toThrow();
    });
  });

  // ── -s/--stable, key/tab validation (GNU parity) ──────────────────────────
  describe('stable and validation', () => {
    test('-s keeps equal-key records in input order', async () => {
      const h = makeIO({ args: ['sort', '-s', '-k1,1'], stdinText: 'a 2\na 1\nb 3\n' });
      expect(await sortCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a 2\na 1\nb 3\n');
    });
    test('--stable long form behaves identically', async () => {
      const h = makeIO({ args: ['sort', '--stable', '-k1,1'], stdinText: 'a 2\na 1\n' });
      expect(await sortCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a 2\na 1\n');
    });
    test('without -s, the whole-line tiebreak reorders equal keys', async () => {
      const h = makeIO({ args: ['sort', '-k1,1'], stdinText: 'a 2\na 1\nb 3\n' });
      expect(await sortCommand(h.io)).toBe(0);
      expect(h.out()).toBe('a 1\na 2\nb 3\n');
    });
    test('-k0 → exit 2 with GNU diagnostic', async () => {
      const h = makeIO({ args: ['sort', '-k0'], stdinText: 'a\nb\n' });
      expect(await sortCommand(h.io)).toBe(2);
      expect(h.err()).toBe('sort: field number is zero: invalid field specification ‘0’\n');
    });
    test('-k1.0 → exit 2 (character offset zero)', async () => {
      const h = makeIO({ args: ['sort', '-k1.0'], stdinText: 'a\nb\n' });
      expect(await sortCommand(h.io)).toBe(2);
      expect(h.err()).toBe('sort: character offset is zero: invalid field specification ‘1.0’\n');
    });
    test('-t \'\' → exit 2 with "empty tab"', async () => {
      const h = makeIO({ args: ['sort', '-t', ''], stdinText: 'ba\nab\n' });
      expect(await sortCommand(h.io)).toBe(2);
      expect(h.err()).toBe('sort: empty tab\n');
    });
  });
});
