import { expect, test } from 'vitest';
import { FileSystemRouter, MemoryFsProvider } from './index.ts';

test('sync MemoryFsProvider is consumable through an async router', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider({ files: { '/tmp/a.txt': 'hello' } }));
  const h = await router.open('/tmp/a.txt', { read: true });
  const data = await router.read(h, 0, 5);
  expect(new TextDecoder().decode(data)).toBe('hello');
  await router.close(h);
});

test('longest-prefix routing works across two mounts', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  await router.mount('/tmp', new MemoryFsProvider());
  expect(router.resolve('/tmp/x').mountPoint).toBe('/tmp');
  expect(router.resolve('/etc/y').mountPoint).toBe('/');
});

test('missing file rejects with no-entry through await', async () => {
  const router = new FileSystemRouter();
  await router.mount('/', new MemoryFsProvider());
  await expect(router.stat('/nope')).rejects.toMatchObject({ code: 'no-entry' });
});
