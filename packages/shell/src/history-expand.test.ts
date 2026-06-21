import { expect, test } from 'vitest';
import { expandHistory, HistoryEventNotFound } from './history-expand.ts';

const H = ['echo one', 'echo two', 'ls -la', 'grep foo bar'];

test('!! expands to the last command', () => {
  expect(expandHistory('!!', H)).toBe('grep foo bar');
});

test('!n is 1-based absolute', () => {
  expect(expandHistory('!1', H)).toBe('echo one');
  expect(expandHistory('!3', H)).toBe('ls -la');
});

test('!-n counts from the end', () => {
  expect(expandHistory('!-1', H)).toBe('grep foo bar');
  expect(expandHistory('!-4', H)).toBe('echo one');
});

test('!string matches most recent prefix', () => {
  expect(expandHistory('!echo', H)).toBe('echo two');
  expect(expandHistory('!ls', H)).toBe('ls -la');
});

test('!?string? matches most recent containing substring', () => {
  expect(expandHistory('!?foo?', H)).toBe('grep foo bar');
  expect(expandHistory('!?one?', H)).toBe('echo one');
});

test('embedded !! within a larger command', () => {
  expect(expandHistory('echo X !! Y', H)).toBe('echo X grep foo bar Y');
});

test('single-quoted ! is literal', () => {
  expect(expandHistory("echo 'a!b'", H)).toBe("echo 'a!b'");
});

test('! followed by space / = / ( is literal', () => {
  expect(expandHistory('[ ! -f x ]', H)).toBe('[ ! -f x ]');
  expect(expandHistory('test a != b', H)).toBe('test a != b');
  expect(expandHistory('echo !(foo)', H)).toBe('echo !(foo)');
});

test('backslash escapes !', () => {
  expect(expandHistory('echo \\!!', H)).toBe('echo \\!!');
});

test('a line without ! is returned unchanged', () => {
  expect(expandHistory('echo plain', H)).toBe('echo plain');
});

test('unresolved reference throws HistoryEventNotFound', () => {
  expect(() => expandHistory('!zzz', H)).toThrow(HistoryEventNotFound);
  expect(() => expandHistory('!99', H)).toThrow(/event not found/);
});

test('!! against empty history throws', () => {
  expect(() => expandHistory('!!', [])).toThrow(HistoryEventNotFound);
});

test('double-quoted ! is still expanded (bash semantics)', () => {
  expect(expandHistory('echo "x !! y"', H)).toBe('echo "x grep foo bar y"');
});
