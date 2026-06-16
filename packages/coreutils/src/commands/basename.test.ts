import { expect, test, describe } from 'vitest';
import { basenameCommand } from './basename.ts';
import { makeIO } from './_testio.ts';

describe('basename', () => {
  test('strips directory', async () => {
    const h = makeIO({ args: ['basename', '/usr/bin/sort'] });
    expect(await basenameCommand(h.io)).toBe(0);
    expect(h.out()).toBe('sort\n');
  });

  test('strips suffix', async () => {
    const h = makeIO({ args: ['basename', '/a/b/file.txt', '.txt'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('file\n');
  });

  test('does not strip when name equals suffix', async () => {
    const h = makeIO({ args: ['basename', '.txt', '.txt'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('.txt\n');
  });

  test('-a multiple', async () => {
    const h = makeIO({ args: ['basename', '-a', '/x/y', '/p/q'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('y\nq\n');
  });

  test('-s suffix implies -a', async () => {
    const h = makeIO({ args: ['basename', '-s', '.c', 'a.c', 'b.c'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('a\nb\n');
  });

  test('trailing slash', async () => {
    const h = makeIO({ args: ['basename', '/a/b/'] });
    await basenameCommand(h.io);
    expect(h.out()).toBe('b\n');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['basename'] });
    expect(await basenameCommand(h.io)).toBe(1);
    expect(h.err()).toContain('missing operand');
  });
});
