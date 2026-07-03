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
});
