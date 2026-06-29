import { expect, test, describe } from 'vitest';
import { csvcolsCommand } from './csvcols.ts';
import { makeIO } from './_testio.ts';

const read = async (fs: ReturnType<typeof makeIO>['fs'], path: string): Promise<string> => {
  const h = await fs.open(path, { read: true });
  const data = await fs.read(h, 0, 1 << 20);
  await fs.close(h);
  return new TextDecoder().decode(data);
};

describe('csvcols', () => {
  test('selects the named columns into the output file', async () => {
    const h = makeIO({
      args: ['csvcols', '/in.csv', '/out.csv'],
      env: { COLS: 'a,c' },
      files: { '/in.csv': 'a,b,c\n1,2,3\n' },
    });
    expect(await csvcolsCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/out.csv')).toBe('a,c\n1,3\n');
  });

  test('reorders columns to match the COLS order', async () => {
    const h = makeIO({
      args: ['csvcols', '/in.csv', '/out.csv'],
      env: { COLS: 'c,a' },
      files: { '/in.csv': 'a,b,c\n1,2,3\n4,5,6\n' },
    });
    expect(await csvcolsCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/out.csv')).toBe('c,a\n3,1\n6,4\n');
  });

  test('resolves cwd-relative input/output paths', async () => {
    const h = makeIO({
      args: ['csvcols', 'in.csv', 'out.csv'],
      cwd: '/work',
      env: { COLS: 'a' },
      files: { '/work/in.csv': 'a,b\n1,2\n' },
    });
    expect(await csvcolsCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/work/out.csv')).toBe('a\n1\n');
  });

  test('a header-only input yields a header-only output', async () => {
    const h = makeIO({
      args: ['csvcols', '/in.csv', '/out.csv'],
      env: { COLS: 'b' },
      files: { '/in.csv': 'a,b,c\n' },
    });
    expect(await csvcolsCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/out.csv')).toBe('b\n');
  });

  test('a single selected column passes through unchanged', async () => {
    const h = makeIO({
      args: ['csvcols', '/in.csv', '/out.csv'],
      env: { COLS: 'b' },
      files: { '/in.csv': 'a,b\nx,y\n' },
    });
    expect(await csvcolsCommand(h.io)).toBe(0);
    expect(await read(h.fs, '/out.csv')).toBe('b\ny\n');
  });

  test('missing operands error with a non-zero exit', async () => {
    const h = makeIO({ args: ['csvcols', '/in.csv'], env: { COLS: 'a' }, files: { '/in.csv': 'a\n1\n' } });
    expect(await csvcolsCommand(h.io)).toBe(1);
    expect(h.err()).toContain('csvcols');
  });

  test('a missing COLS env errors', async () => {
    const h = makeIO({ args: ['csvcols', '/in.csv', '/out.csv'], files: { '/in.csv': 'a,b\n1,2\n' } });
    expect(await csvcolsCommand(h.io)).toBe(1);
    expect(h.err()).toContain('csvcols');
  });

  test('an unknown column name errors', async () => {
    const h = makeIO({
      args: ['csvcols', '/in.csv', '/out.csv'],
      env: { COLS: 'a,zzz' },
      files: { '/in.csv': 'a,b\n1,2\n' },
    });
    expect(await csvcolsCommand(h.io)).toBe(1);
    expect(h.err()).toMatch(/zzz/);
  });

  test('a missing input file errors', async () => {
    const h = makeIO({ args: ['csvcols', '/nope.csv', '/out.csv'], env: { COLS: 'a' } });
    expect(await csvcolsCommand(h.io)).toBe(1);
    expect(h.err()).toContain('csvcols');
  });

  test('an empty input file errors (no header row)', async () => {
    const h = makeIO({
      args: ['csvcols', '/in.csv', '/out.csv'],
      env: { COLS: 'a' },
      files: { '/in.csv': '' },
    });
    expect(await csvcolsCommand(h.io)).toBe(1);
    expect(h.err()).toContain('csvcols');
  });
});
