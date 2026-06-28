import { describe, it, expect } from 'vitest';
import { parseShebang, classifyExecutable, resolveName } from './exec-resolve.ts';

describe('parseShebang', () => {
  it('extracts the interpreter path from a leading shebang line', () => {
    expect(parseShebang('#!/bin/node\nconsole.log(1)')).toEqual({ interpreter: '/bin/node' });
  });
  it('splits off a single argument after the interpreter', () => {
    expect(parseShebang('#!/usr/bin/env node\n')).toEqual({ interpreter: '/usr/bin/env', arg: 'node' });
  });
  it('tolerates whitespace between #! and the path', () => {
    expect(parseShebang('#!  /bin/bash\n')).toEqual({ interpreter: '/bin/bash' });
  });
  it('handles a shebang with no trailing newline (whole file is the line)', () => {
    expect(parseShebang('#!/bin/node')).toEqual({ interpreter: '/bin/node' });
  });
  it('returns undefined when there is no shebang', () => {
    expect(parseShebang('console.log(1)')).toBeUndefined();
    expect(parseShebang('')).toBeUndefined();
    expect(parseShebang('  #!/bin/node')).toBeUndefined(); // shebang must be at byte 0
  });
});

describe('classifyExecutable', () => {
  it('treats #!/bin/node as a guest', () => {
    expect(classifyExecutable('#!/bin/node\nx')).toEqual({ kind: 'guest' });
  });
  it('treats a missing shebang as a guest (default JS case)', () => {
    expect(classifyExecutable('export default 1')).toEqual({ kind: 'guest' });
  });
  it('treats #!/bin/bash as an interpreter dispatch to the shell', () => {
    expect(classifyExecutable('#!/bin/bash\nset -e')).toEqual({ kind: 'interpreter', interpreter: '/bin/bash' });
  });
  it('treats any other shebang as an interpreter to be re-resolved', () => {
    expect(classifyExecutable('#!/usr/bin/python\nprint(1)')).toEqual({
      kind: 'interpreter',
      interpreter: '/usr/bin/python',
    });
  });
});

describe('resolveName', () => {
  const builtins = new Set(['cd', 'export', ':']);
  const exists = (p: string) => p === '/usr/bin/resize' || p === '/bin/sh' || p === '/abs/tool' || p === './rel/tool';

  it('resolves a builtin first, before any PATH walk', () => {
    expect(resolveName('cd', { builtins, pathDirs: ['/usr/bin'], exists })).toEqual({ layer: 'builtin' });
  });
  it('resolves a bare name via the first matching PATH dir', () => {
    expect(resolveName('resize', { builtins, pathDirs: ['/sbin', '/usr/bin'], exists })).toEqual({
      layer: 'file',
      path: '/usr/bin/resize',
    });
  });
  it('returns not-found for an unresolvable bare name', () => {
    expect(resolveName('nope', { builtins, pathDirs: ['/usr/bin'], exists })).toEqual({ layer: 'not-found' });
  });
  it('uses an absolute path directly when it exists', () => {
    expect(resolveName('/abs/tool', { builtins, pathDirs: [], exists })).toEqual({ layer: 'file', path: '/abs/tool' });
  });
  it('uses a ./ relative path directly when it exists', () => {
    expect(resolveName('./rel/tool', { builtins, pathDirs: [], exists })).toEqual({
      layer: 'file',
      path: './rel/tool',
    });
  });
  it('returns not-found for an explicit path that does not exist (never PATH-walked)', () => {
    expect(resolveName('/abs/missing', { builtins, pathDirs: ['/usr/bin'], exists })).toEqual({ layer: 'not-found' });
    expect(resolveName('./missing', { builtins, pathDirs: ['/usr/bin'], exists })).toEqual({ layer: 'not-found' });
  });
  it('a builtin name is a builtin even if an explicit path form exists (only bare names hit builtins)', () => {
    // an absolute path that happens to look like a builtin is still a path
    expect(resolveName('/abs/tool', { builtins: new Set(['/abs/tool']), pathDirs: [], exists })).toEqual({
      layer: 'file',
      path: '/abs/tool',
    });
  });
  it('handles empty pathDirs gracefully for a bare name', () => {
    expect(resolveName('resize', { builtins, pathDirs: [], exists })).toEqual({ layer: 'not-found' });
  });
  it('does not treat ../ relative paths as bare names', () => {
    const ex = (p: string) => p === '../up/tool';
    expect(resolveName('../up/tool', { builtins, pathDirs: ['/usr/bin'], exists: ex })).toEqual({
      layer: 'file',
      path: '../up/tool',
    });
  });
});
