import { expect, test, describe } from 'vitest';
import { findCommand, globToRegExp } from './find.ts';
import { makeIO } from './_testio.ts';

describe('find glob', () => {
  test('* matches within a component', () => {
    expect(globToRegExp('*.txt').test('a.txt')).toBe(true);
    expect(globToRegExp('*.txt').test('a.md')).toBe(false);
  });
  test('? matches one char', () => {
    expect(globToRegExp('?.c').test('a.c')).toBe(true);
    expect(globToRegExp('?.c').test('ab.c')).toBe(false);
  });
  test('character class', () => {
    expect(globToRegExp('[ab].x').test('a.x')).toBe(true);
    expect(globToRegExp('[ab].x').test('c.x')).toBe(false);
  });
});

const files = { '/r/a.txt': '1', '/r/b.md': '2', '/r/sub/c.txt': '3', '/r/sub/deep/d.txt': '4' };

describe('find', () => {
  test('prints everything under the start path', async () => {
    const h = makeIO({ args: ['find', '/r'], files });
    expect(await findCommand(h.io)).toBe(0);
    const lines = h.out().trim().split('\n');
    expect(lines).toContain('/r');
    expect(lines).toContain('/r/a.txt');
    expect(lines).toContain('/r/sub/deep/d.txt');
  });

  test('-name filters by glob', async () => {
    const h = makeIO({ args: ['find', '/r', '-name', '*.txt'], files });
    await findCommand(h.io);
    const lines = h.out().trim().split('\n');
    expect(lines).toEqual(['/r/a.txt', '/r/sub/c.txt', '/r/sub/deep/d.txt']);
  });

  test('-type d lists only directories', async () => {
    const h = makeIO({ args: ['find', '/r', '-type', 'd'], files });
    await findCommand(h.io);
    const lines = h.out().trim().split('\n');
    expect(lines).toEqual(['/r', '/r/sub', '/r/sub/deep']);
  });

  test('-maxdepth limits descent', async () => {
    const h = makeIO({ args: ['find', '/r', '-maxdepth', '1'], files });
    await findCommand(h.io);
    expect(h.out()).not.toContain('/r/sub/c.txt');
    expect(h.out()).toContain('/r/a.txt');
  });

  test('-mindepth skips shallow entries', async () => {
    const h = makeIO({ args: ['find', '/r', '-mindepth', '2'], files });
    await findCommand(h.io);
    expect(h.out()).not.toContain('/r/a.txt');
    expect(h.out()).toContain('/r/sub/c.txt');
  });

  test('-exec is deferred (reports unsupported)', async () => {
    const h = makeIO({ args: ['find', '/r', '-exec', 'echo', '{}', ';'], files });
    expect(await findCommand(h.io)).toBe(1);
    expect(h.err()).toContain('-exec is not supported');
  });

  test('unknown predicate errors', async () => {
    const h = makeIO({ args: ['find', '/r', '-bogus'], files });
    expect(await findCommand(h.io)).toBe(1);
  });
});
