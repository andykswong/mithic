import { expect, test, describe } from 'vitest';
import { treeCommand } from './tree.ts';
import { makeIO } from './_testio.ts';

const files = { '/r/a': '1', '/r/sub/b': '2' };

describe('tree', () => {
  test('connector layout + summary (root not counted, like real tree)', async () => {
    const h = makeIO({ args: ['tree', '/r'], files });
    expect(await treeCommand(h.io)).toBe(0);
    expect(h.out()).toBe(
      '/r\n' +
      '├── a\n' +
      '└── sub\n' +
      '    └── b\n' +
      '\n' +
      '1 directory, 2 files\n',
    );
  });

  test('-L 1 limits depth to the top level', async () => {
    const h = makeIO({ args: ['tree', '-L', '1', '/r'], files });
    await treeCommand(h.io);
    expect(h.out()).toBe(
      '/r\n' +
      '├── a\n' +
      '└── sub\n' +
      '\n' +
      '1 directory, 1 file\n',
    );
  });

  test('-d lists directories only', async () => {
    const h = makeIO({ args: ['tree', '-d', '/r'], files });
    await treeCommand(h.io);
    expect(h.out()).toBe(
      '/r\n' +
      '└── sub\n' +
      '\n' +
      '1 directory\n',
    );
  });

  test('-a includes dotfiles', async () => {
    const h = makeIO({ args: ['tree', '/r'], files: { '/r/.hidden': 'x', '/r/v': 'y' } });
    await treeCommand(h.io);
    expect(h.out()).not.toContain('.hidden');

    const h2 = makeIO({ args: ['tree', '-a', '/r'], files: { '/r/.hidden': 'x', '/r/v': 'y' } });
    await treeCommand(h2.io);
    expect(h2.out()).toContain('.hidden');
  });
});
