import { expect, test, describe } from 'vitest';
import { dirnameCommand } from './dirname.ts';
import { makeIO } from './_testio.ts';

describe('dirname', () => {
  test('strips last component', async () => {
    const h = makeIO({ args: ['dirname', '/a/b/c'] });
    expect(await dirnameCommand(h.io)).toBe(0);
    expect(h.out()).toBe('/a/b\n');
  });

  test('no slash yields dot', async () => {
    const h = makeIO({ args: ['dirname', 'file'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('.\n');
  });

  test('root stays root', async () => {
    const h = makeIO({ args: ['dirname', '/x'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('/\n');
  });

  test('multiple operands', async () => {
    const h = makeIO({ args: ['dirname', '/a/b', '/c/d'] });
    await dirnameCommand(h.io);
    expect(h.out()).toBe('/a\n/c\n');
  });

  test('missing operand errors', async () => {
    const h = makeIO({ args: ['dirname'] });
    expect(await dirnameCommand(h.io)).toBe(1);
  });
});
