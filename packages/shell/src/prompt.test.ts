import { expect, test } from 'vitest';
import { expandPrompt } from './prompt.ts';

test('\\w collapses $HOME to ~ and \\$ is a literal $', () => {
  expect(expandPrompt('\\w\\$ ', { cwd: '/home', env: { HOME: '/home' } })).toBe('~$ ');
});

test('\\w shows the full cwd when not under $HOME', () => {
  expect(expandPrompt('\\w\\$ ', { cwd: '/tmp', env: { HOME: '/home' } })).toBe('/tmp$ ');
});

test('\\w with HOME=/ collapses only / itself (not /tmp -> ~tmp)', () => {
  expect(expandPrompt('\\w', { cwd: '/', env: { HOME: '/' } })).toBe('~');
  expect(expandPrompt('\\w', { cwd: '/tmp', env: { HOME: '/' } })).toBe('/tmp');
});

test('\\w under a HOME subdir collapses the prefix to ~', () => {
  expect(expandPrompt('\\w', { cwd: '/home/user/proj', env: { HOME: '/home/user' } })).toBe('~/proj');
});

test('\\W is the basename of cwd (root is /)', () => {
  expect(expandPrompt('\\W', { cwd: '/var/log', env: {} })).toBe('log');
  expect(expandPrompt('\\W', { cwd: '/', env: {} })).toBe('/');
});

test('\\u uses $USER (defaults to user); \\h uses hostname (defaults to mithic)', () => {
  expect(expandPrompt('\\u@\\h', { cwd: '/', env: { USER: 'andy', HOSTNAME: 'box' } })).toBe('andy@box');
  expect(expandPrompt('\\u@\\h', { cwd: '/', env: {} })).toBe('user@mithic');
});

test('\\e / \\033 expand to ESC and \\a to BEL', () => {
  const out = expandPrompt('\\e[1;32m\\w\\033[0m\\$ ', { cwd: '/tmp', env: {} });
  expect(out).toContain('\x1b');
  expect(out).toContain('/tmp');
  expect(out).toContain('$');
  expect(out.startsWith('\x1b[1;32m')).toBe(true);
  expect(expandPrompt('\\a', { cwd: '/', env: {} })).toBe('\x07');
});

test('\\n \\r \\\\ literal escapes', () => {
  expect(expandPrompt('a\\nb\\rc\\\\d', { cwd: '/', env: {} })).toBe('a\nb\rc\\d');
});

test('the bashrc PS1 produces a green-cwd prompt', () => {
  const out = expandPrompt('\\e[1;32m\\w\\e[0m\\$ ', { cwd: '/', env: { HOME: '/' } });
  expect(out).toBe('\x1b[1;32m~\x1b[0m$ ');
});
