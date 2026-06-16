import { expect, test } from 'vitest';
import { FdTable } from './fd-table.ts';

test('allocates fds starting at 3 and tracks entries', () => {
  const t = new FdTable();
  const { port1 } = new MessageChannel();
  const fd = t.add({ type: 'pipe', port: port1, rights: { read: true, write: false, seek: false, stat: true, truncate: false }, flags: { append: false, nonblock: false } });
  expect(fd).toBe(3);
  expect(t.get(fd)?.type).toBe('pipe');
});

test('set installs a specific fd (for stdio 0/1/2)', () => {
  const t = new FdTable();
  const { port1 } = new MessageChannel();
  t.set(1, { type: 'pipe', port: port1, rights: { read: false, write: true, seek: false, stat: true, truncate: false }, flags: { append: false, nonblock: false } });
  expect(t.get(1)?.rights.write).toBe(true);
});

test('close removes and detach returns the port', () => {
  const t = new FdTable();
  const { port1 } = new MessageChannel();
  const fd = t.add({ type: 'pipe', port: port1, rights: { read: true, write: true, seek: false, stat: true, truncate: false }, flags: { append: false, nonblock: false } });
  expect(t.detach(fd)).toBe(port1);
  expect(t.get(fd)).toBeUndefined();
});
