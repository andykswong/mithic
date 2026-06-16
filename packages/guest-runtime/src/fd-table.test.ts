import { expect, test } from 'vitest';
import { FdTable, makeDefaultEntry } from './fd-table.ts';

test('FdTable set and get', () => {
  const table = new FdTable();
  const entry = makeDefaultEntry({ rights: { read: true, write: false, seek: false, stat: false, truncate: false } });
  table.set(0, entry);
  const got = table.get(0);
  expect(got?.fd).toBe(0);
  expect(got?.rights.read).toBe(true);
  expect(got?.rights.write).toBe(false);
});

test('FdTable alloc assigns next fd', () => {
  const table = new FdTable();
  const fd1 = table.alloc(makeDefaultEntry());
  const fd2 = table.alloc(makeDefaultEntry());
  expect(fd1).toBe(3);
  expect(fd2).toBe(4);
});

test('FdTable close removes entry', () => {
  const table = new FdTable();
  table.set(5, makeDefaultEntry());
  expect(table.has(5)).toBe(true);
  expect(table.close(5)).toBe(true);
  expect(table.has(5)).toBe(false);
  expect(table.close(5)).toBe(false);
});

test('FdTable size tracks entries', () => {
  const table = new FdTable();
  expect(table.size).toBe(0);
  table.set(0, makeDefaultEntry());
  table.set(1, makeDefaultEntry());
  expect(table.size).toBe(2);
  table.close(0);
  expect(table.size).toBe(1);
});
