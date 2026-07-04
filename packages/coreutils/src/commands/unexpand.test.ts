import { expect, test, describe } from 'vitest';
import { unexpandCommand } from './unexpand.ts';
import { makeIO } from './_testio.ts';

describe('unexpand', () => {
  test('leading 8 spaces become a tab (default)', async () => {
    const h = makeIO({ args: ['unexpand', '/in'], files: { '/in': '        x\n' } });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\tx\n');
  });

  test('by default only leading whitespace is converted', async () => {
    // The 8 spaces between a and b are NOT converted without -a.
    const h = makeIO({ args: ['unexpand', '/in'], files: { '/in': 'a        b\n' } });
    await unexpandCommand(h.io);
    expect(h.out()).toBe('a        b\n');
  });

  test('-a converts runs of spaces anywhere to tabs at tabstops', async () => {
    const h = makeIO({ args: ['unexpand', '-a', '/in'], files: { '/in': 'ab      x\n' } });
    await unexpandCommand(h.io);
    expect(h.out()).toBe('ab\tx\n'); // 6 spaces from col 2 reach col 8 → one tab
  });

  test('-t 4 uses a 4-column tabstop', async () => {
    const h = makeIO({ args: ['unexpand', '-t', '4', '/in'], files: { '/in': '    x\n' } });
    await unexpandCommand(h.io);
    expect(h.out()).toBe('\tx\n');
  });

  // C4a: GNU keeps converting leading whitespace through a leading tab — the
  // tab does not end the leading run.
  test('converts leading whitespace through a leading tab', async () => {
    // tab (col 0→8) + 8 spaces (col 8→16, a tabstop) + x → "\t\tx"
    const h = makeIO({ args: ['unexpand', '/in'], files: { '/in': '\t        x\n' } });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\t\tx\n');
  });

  test('a leading tab still stops conversion at the first non-blank', async () => {
    // tab + 8 spaces collapse, but the spaces AFTER the non-blank `y` stay.
    const h = makeIO({ args: ['unexpand', '/in'], files: { '/in': '\t        y        z\n' } });
    await unexpandCommand(h.io);
    expect(h.out()).toBe('\t\ty        z\n');
  });

  describe('-t LIST', () => {
    test('explicit stops convert leading run', async () => {
      const h = makeIO({ args: ['unexpand', '-t', '4,8', '/in'], files: { '/in': '        x\n' } });
      expect(await unexpandCommand(h.io)).toBe(0);
      expect(h.out()).toBe('\t\tx\n');
    });
    test('past the last explicit stop, blanks are NOT converted', async () => {
      // -a implied by -t; 2 tabs to col8, then 4 remaining spaces (no stop past 8) stay.
      const h = makeIO({ args: ['unexpand', '-a', '-t', '4,8', '/in'], files: { '/in': 'a       b       c\n' } });
      await unexpandCommand(h.io);
      expect(h.out()).toBe('a\t\tb       c\n');
    });
    test('any -t implies -a (embedded runs convert)', async () => {
      const h = makeIO({ args: ['unexpand', '-t', '8', '/in'], files: { '/in': 'xy      z\n' } });
      await unexpandCommand(h.io);
      expect(h.out()).toBe('xy\tz\n');
    });
    test('default (no -t) converts only the leading run', async () => {
      const h = makeIO({ args: ['unexpand', '/in'], files: { '/in': 'xy      z\n' } });
      await unexpandCommand(h.io);
      expect(h.out()).toBe('xy      z\n');
    });
    test('tab size 0 rejected', async () => {
      const h = makeIO({ args: ['unexpand', '-t', '0', '/in'], files: { '/in': '  x\n' } });
      expect(await unexpandCommand(h.io)).toBe(1);
      expect(h.err()).toContain('unexpand: tab size cannot be 0');
    });
    test('non-ascending list rejected', async () => {
      const h = makeIO({ args: ['unexpand', '-t', '5,3', '/in'], files: { '/in': '  x\n' } });
      expect(await unexpandCommand(h.io)).toBe(1);
      expect(h.err()).toContain('unexpand: tab sizes must be ascending');
    });
  });

  test('unknown flag exits 1', async () => {
    const h = makeIO({ args: ['unexpand', '-Q', '/in'], files: { '/in': 'x\n' } });
    expect(await unexpandCommand(h.io)).toBe(1);
    expect(h.err()).toContain('unexpand: invalid option -- \'Q\'');
  });

  // ── obsolete -N shorthand + GNU tabify parity ─────────────────────────────
  test('-a -2 collapses each blank stretch to a tab at the width-2 stops', async () => {
    const h = makeIO({ args: ['unexpand', '-a', '-2'], stdinText: '  a  b\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\ta\t b\n');
  });

  test('-4 (obsolete) does NOT imply -a (only leading blanks converted)', async () => {
    // Unlike an explicit -t, the obsolete -N form leaves interior blanks alone.
    const h = makeIO({ args: ['unexpand', '-2'], stdinText: '  a  b\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\ta  b\n');
  });

  test('-t2 (explicit) DOES imply -a', async () => {
    const h = makeIO({ args: ['unexpand', '-t2'], stdinText: '  a  b\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\ta\t b\n');
  });

  test('-a: a lone space landing on the last stop stays a space (default width 8)', async () => {
    const h = makeIO({ args: ['unexpand', '-a'], stdinText: 'abcdefg h\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abcdefg h\n');
  });

  test('-a: a 1-column bridge tabs when the run continues past the stop', async () => {
    const h = makeIO({ args: ['unexpand', '-a'], stdinText: 'abcdefg  h\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('abcdefg\t h\n');
  });

  test('-a -t 1,3,5: single space before the LAST explicit stop stays a space', async () => {
    const h = makeIO({ args: ['unexpand', '-a', '-t', '1,3,5'], stdinText: 'word    word\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('word    word\n');
  });

  // ── R4: a -t value that looks like -NUMBER is not the obsolete shorthand ───
  test('-t -1 error quotes the VALUE token, not -t (R4 regression)', async () => {
    const h = makeIO({ args: ['unexpand', '-t', '-1'], stdinText: 'a\tb\n' });
    expect(await unexpandCommand(h.io)).toBe(1);
    expect(h.err()).toBe('unexpand: tab size contains invalid character(s): ‘-1’\n');
  });

  test('standalone -4 obsolete shorthand still works', async () => {
    const h = makeIO({ args: ['unexpand', '-4'], stdinText: '    a\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\ta\n');
  });

  // ── L8: --first-only means LEADING-only (like the default, NOT -a) ─────────
  test('--first-only converts only the leading blank run', async () => {
    const h = makeIO({ args: ['unexpand', '--first-only'], stdinText: '        a       b\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('\ta       b\n');
  });

  test('--first (unambiguous prefix of --first-only) leaves interior spaces', async () => {
    const h = makeIO({ args: ['unexpand', '--first'], stdinText: 'a        b        c\n' });
    expect(await unexpandCommand(h.io)).toBe(0);
    expect(h.out()).toBe('a        b        c\n');
  });

  // ── file-read failure exits 1 (parity finding) ────────────────────────────
  test('missing file operand exits 1', async () => {
    const h = makeIO({ args: ['unexpand', '/noexist'] });
    expect(await unexpandCommand(h.io)).toBe(1);
    expect(h.err()).toContain('unexpand: /noexist: No such file or directory');
  });
});
