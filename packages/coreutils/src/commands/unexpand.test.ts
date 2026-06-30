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
});
