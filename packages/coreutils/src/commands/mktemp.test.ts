import { expect, test, describe } from 'vitest';
import { mktempCommand, fillTemplate, entropy } from './mktemp.ts';
import { makeIO } from './_testio.ts';

describe('mktemp helpers', () => {
  test('fillTemplate replaces only the trailing X run', () => {
    expect(fillTemplate('tmp.XXXXXX', 'ABCDEF')).toBe('tmp.ABCDEF');
    expect(fillTemplate('Xfile.XXX', 'abc')).toBe('Xfile.abc');
  });
  test('entropy is deterministic for the same inputs', () => {
    expect(entropy(7, 1, 0, 6)).toBe(entropy(7, 1, 0, 6));
  });
  test('entropy differs when the counter changes', () => {
    expect(entropy(7, 1, 0, 6)).not.toBe(entropy(7, 2, 0, 6));
  });
  test('entropy uses only the base-62 alphabet', () => {
    expect(/^[0-9A-Za-z]+$/.test(entropy(123, 5, 99, 10))).toBe(true);
  });
});

describe('mktemp', () => {
  test('creates a file in /tmp and prints its path', async () => {
    const h = makeIO({ args: ['mktemp'], files: { '/tmp/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(0);
    const path = h.out().trim();
    expect(path.startsWith('/tmp/tmp.')).toBe(true);
    expect((await h.fs.stat(path)).type).toBe('file');
  });

  test('-d creates a directory', async () => {
    const h = makeIO({ args: ['mktemp', '-d', 'mydir.XXXXXX'], files: { '/tmp/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(0);
    const path = h.out().trim();
    expect((await h.fs.stat(path)).type).toBe('directory');
  });

  test('-u dry run does not create', async () => {
    const h = makeIO({ args: ['mktemp', '-u', 'x.XXXXXX'], files: { '/tmp/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(0);
    const path = h.out().trim();
    await expect(async () => h.fs.stat(path)).rejects.toThrow();
  });

  test('-p places result under the given dir', async () => {
    const h = makeIO({ args: ['mktemp', '-p', '/work', 'f.XXXXXX'], files: { '/work/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(0);
    expect(h.out().trim().startsWith('/work/f.')).toBe(true);
  });

  test('too few Xs errors', async () => {
    const h = makeIO({ args: ['mktemp', 'bad.XX'], files: { '/tmp/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(1);
    expect(h.err()).toContain('too few X\'s');
  });

  test('--suffix appends a suffix after the filled template (M23)', async () => {
    const h = makeIO({ args: ['mktemp', '--suffix', '.txt', 'f.XXXXXX'], files: { '/tmp/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(0);
    const path = h.out().trim();
    expect(path.startsWith('/tmp/f.')).toBe(true);
    expect(path.endsWith('.txt')).toBe(true);
    expect((await h.fs.stat(path)).type).toBe('file');
  });

  test('--suffix is honored on a dry-run too', async () => {
    const h = makeIO({ args: ['mktemp', '-u', '--suffix=.log', 'x.XXXXXX'], files: { '/tmp/.keep': '' } });
    expect(await mktempCommand(h.io)).toBe(0);
    expect(h.out().trim().endsWith('.log')).toBe(true);
  });

  test('two calls in the same process do not collide', async () => {
    const h1 = makeIO({ args: ['mktemp'], files: { '/tmp/.keep': '' }, pid: 99 });
    const h2 = makeIO({ args: ['mktemp'], files: { '/tmp/.keep': '' }, pid: 99 });
    await mktempCommand(h1.io);
    await mktempCommand(h2.io);
    expect(h1.out().trim()).not.toBe(h2.out().trim());
  });
});
