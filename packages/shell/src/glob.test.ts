import { expect, test } from 'vitest';
import { globMatch } from './glob.ts';

// ── basic ────────────────────────────────────────────────────────────────────

test('* matches within a segment', () => {
  expect(globMatch('file.txt', '*.txt')).toBe(true);
  expect(globMatch('file.rs', '*.txt')).toBe(false);
});

test('? matches one char', () => {
  expect(globMatch('ab', 'a?')).toBe(true);
  expect(globMatch('abc', 'a?')).toBe(false);
});

test('[abc] bracket class', () => {
  expect(globMatch('b', '[abc]')).toBe(true);
  expect(globMatch('d', '[abc]')).toBe(false);
});

test('[!abc] negated class', () => {
  expect(globMatch('d', '[!abc]')).toBe(true);
  expect(globMatch('a', '[!abc]')).toBe(false);
});

// ── M12: POSIX character classes ─────────────────────────────────────────────

test('[[:digit:]] matches a digit', () => {
  expect(globMatch('5', '[[:digit:]]')).toBe(true);
  expect(globMatch('x', '[[:digit:]]')).toBe(false);
});

test('[[:alpha:]] matches a letter', () => {
  expect(globMatch('q', '[[:alpha:]]')).toBe(true);
  expect(globMatch('1', '[[:alpha:]]')).toBe(false);
});

test('[[:alnum:]]* matches identifier-ish', () => {
  expect(globMatch('a1b2', '[[:alnum:]]*')).toBe(true);
});

test('[[:upper:]] and [[:lower:]]', () => {
  expect(globMatch('A', '[[:upper:]]')).toBe(true);
  expect(globMatch('a', '[[:upper:]]')).toBe(false);
  expect(globMatch('a', '[[:lower:]]')).toBe(true);
});

test('mixed POSIX class and literals [[:digit:]]x', () => {
  expect(globMatch('3x', '[[:digit:]]x')).toBe(true);
  expect(globMatch('xx', '[[:digit:]]x')).toBe(false);
});

// ── M12: globstar ** ─────────────────────────────────────────────────────────

test('** matches across slashes', () => {
  expect(globMatch('a/b/c', '**')).toBe(true);
  expect(globMatch('a/b/c.txt', '**/*.txt')).toBe(true);
});

// ── M7: extglob (gated) ──────────────────────────────────────────────────────

test('@(foo|bar) matches exactly one alternative', () => {
  const o = { extglob: true };
  expect(globMatch('foo', '@(foo|bar)', o)).toBe(true);
  expect(globMatch('bar', '@(foo|bar)', o)).toBe(true);
  expect(globMatch('baz', '@(foo|bar)', o)).toBe(false);
  expect(globMatch('foobar', '@(foo|bar)', o)).toBe(false);
});

test('?(foo) matches zero or one', () => {
  const o = { extglob: true };
  expect(globMatch('', '?(foo)', o)).toBe(true);
  expect(globMatch('foo', '?(foo)', o)).toBe(true);
  expect(globMatch('foofoo', '?(foo)', o)).toBe(false);
});

test('*(foo) matches zero or more', () => {
  const o = { extglob: true };
  expect(globMatch('', '*(foo)', o)).toBe(true);
  expect(globMatch('foofoo', '*(foo)', o)).toBe(true);
  expect(globMatch('bar', '*(foo)', o)).toBe(false);
});

test('+(foo) matches one or more', () => {
  const o = { extglob: true };
  expect(globMatch('', '+(foo)', o)).toBe(false);
  expect(globMatch('foofoo', '+(foo)', o)).toBe(true);
});

test('!(foo|bar) matches anything except', () => {
  const o = { extglob: true };
  expect(globMatch('baz', '!(foo|bar)', o)).toBe(true);
  expect(globMatch('foo', '!(foo|bar)', o)).toBe(false);
  expect(globMatch('bar', '!(foo|bar)', o)).toBe(false);
});

test('extglob with prefix/suffix foo@(bar|baz)', () => {
  const o = { extglob: true };
  expect(globMatch('foobar', 'foo@(bar|baz)', o)).toBe(true);
  expect(globMatch('fooqux', 'foo@(bar|baz)', o)).toBe(false);
});

// ── R1: !() negation embedded mid-pattern (regression) ───────────────────────

test('embedded !(foo): x!(foo)y does NOT match xfooy, matches xbary', () => {
  const o = { extglob: true };
  expect(globMatch('xfooy', 'x!(foo)y', o)).toBe(false);
  expect(globMatch('xbary', 'x!(foo)y', o)).toBe(true);
  // empty middle: !(foo) can match the empty string, so "xy" matches
  expect(globMatch('xy', 'x!(foo)y', o)).toBe(true);
  // negated span that merely CONTAINS foo (but isn't exactly foo) matches
  expect(globMatch('xffooy', 'x!(foo)y', o)).toBe(true);
  expect(globMatch('xfooyfooy', 'x!(foo)y', o)).toBe(true);
});

test('standalone !(foo) matches multi-copy foofoo (!= foo)', () => {
  const o = { extglob: true };
  expect(globMatch('foofoo', '!(foo)', o)).toBe(true);
  expect(globMatch('foobar', '!(foo)', o)).toBe(true);
});

test('standalone !(foo) still correct', () => {
  const o = { extglob: true };
  expect(globMatch('bar', '!(foo)', o)).toBe(true);
  expect(globMatch('foo', '!(foo)', o)).toBe(false);
  expect(globMatch('', '!(foo)', o)).toBe(true);
});

test('!() with suffix: !(foo).txt', () => {
  const o = { extglob: true };
  expect(globMatch('bar.txt', '!(foo).txt', o)).toBe(true);
  // bash: "foo.txt" does NOT match !(foo).txt because foo is excluded before .txt
  expect(globMatch('foo.txt', '!(foo).txt', o)).toBe(false);
  // "foobar.txt" matches (foobar != foo)
  expect(globMatch('foobar.txt', '!(foo).txt', o)).toBe(true);
});

test('empty !() negation: !() matches nothing-excluded (any string)', () => {
  const o = { extglob: true };
  // !() excludes the empty alternative, so it matches any NON-empty string
  expect(globMatch('anything', '!()', o)).toBe(true);
  expect(globMatch('', '!()', o)).toBe(false);
});

test('@( ) is literal when extglob disabled', () => {
  expect(globMatch('foo', '@(foo)')).toBe(false); // treated literally → no match
});
