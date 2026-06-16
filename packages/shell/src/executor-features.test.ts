/* eslint-disable @typescript-eslint/no-explicit-any -- feature tests use a minimal mock kernel typed as any */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';
import type { ShellContext } from './executor.ts';
import { parse } from './parser.ts';

function mockKernel() {
  const spawned: any[] = [];
  return {
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
}

/** In-memory VFS supporting open/read/write/readdir/stat. */
function mockFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  let nextFd = 10;
  const open = new Map<number, { path: string; mode: string; buf: string }>();
  return {
    files,
    fsOpen(path: string, flags: any): number {
      const fd = nextFd++;
      let buf = '';
      if (flags.append && files.has(path)) buf = files.get(path)!;
      open.set(fd, { path, mode: flags.read ? 'r' : flags.append ? 'a' : 'w', buf });
      return fd;
    },
    fsWrite(fd: number, data: string) { open.get(fd)!.buf += data; },
    fsRead(fd: number) { return files.get(open.get(fd)!.path) ?? ''; },
    fsClose(fd: number) { const e = open.get(fd)!; if (e.mode !== 'r') files.set(e.path, e.buf); open.delete(fd); },
    fsReaddir(path: string): string[] {
      const prefix = path === '/' ? '/' : path.replace(/\/$/, '') + '/';
      const names = new Set<string>();
      for (const p of files.keys()) if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length); const s = rest.indexOf('/');
        names.add(s >= 0 ? rest.slice(0, s) : rest);
      }
      return [...names];
    },
    fsStat(path: string) {
      if (files.has(path)) return { dir: false };
      const prefix = path.replace(/\/$/, '') + '/';
      for (const p of files.keys()) if (p.startsWith(prefix)) return { dir: true };
      return undefined;
    },
  };
}

async function run(script: string, ctx: Partial<ShellContext> = {}, fs?: any) {
  const k = mockKernel();
  let out = '';
  let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx }, {
    onStdout: (s) => { out += s; },
    onStderr: (s) => { err += s; },
    fs,
    // Unknown commands resolve to undefined → "command not found".
    resolve: (name) => (name.startsWith('nonexistent') ? undefined : name),
  });
  const code = await ex.run(parse(script));
  return { out, err, code, ex };
}

// ── $? / $PIPESTATUS / special params ───────────────────────────────────────

test('$? reflects last command status', async () => {
  expect((await run('true; echo $?')).out.trim()).toBe('0');
  expect((await run('false; echo $?')).out.trim()).toBe('1');
});

test('$PIPESTATUS captures per-stage codes', async () => {
  const { out } = await run('true | false | true; echo ${PIPESTATUS}');
  expect(out.trim()).toBe('0 1 0');
});

test('$# $1 $@ positional params', async () => {
  const { out } = await run('echo $# $1 $2 "$@"', { positional: ['a', 'b'] });
  expect(out.trim()).toBe('2 a b a b');
});

test('$$ and $0', async () => {
  const { out } = await run('echo $0 $$', { name: 'myshell', pid: 4242 });
  expect(out.trim()).toBe('myshell 4242');
});

// ── parameter expansion in a real command ───────────────────────────────────

test('${VAR:-default} via echo', async () => {
  expect((await run('echo ${X:-fallback}')).out.trim()).toBe('fallback');
  expect((await run('echo ${X:-fallback}', { env: { X: 'set' } })).out.trim()).toBe('set');
});

test('${#VAR} and substring', async () => {
  expect((await run('echo ${#V}', { env: { V: 'hello' } })).out.trim()).toBe('5');
  expect((await run('echo ${V:1:3}', { env: { V: 'abcdef' } })).out.trim()).toBe('bcd');
});

// ── brace expansion ──────────────────────────────────────────────────────────

test('brace expansion produces multiple args', async () => {
  expect((await run('echo a{1,2,3}b')).out.trim()).toBe('a1b a2b a3b');
  expect((await run('echo {1..4}')).out.trim()).toBe('1 2 3 4');
});

// ── arithmetic ────────────────────────────────────────────────────────────────

test('$(( )) arithmetic expansion', async () => {
  expect((await run('echo $(( 6 * 7 ))')).out.trim()).toBe('42');
  expect((await run('x=3; echo $(( x + 1 ))')).out.trim()).toBe('4');
});

test('(( )) arithmetic command sets status', async () => {
  expect((await run('(( 1 + 1 )); echo $?')).out.trim()).toBe('0');
  expect((await run('(( 0 )); echo $?')).out.trim()).toBe('1');
});

// ── command substitution ──────────────────────────────────────────────────────

test('$(cmd) command substitution', async () => {
  expect((await run('echo "[$(echo hi)]"')).out.trim()).toBe('[hi]');
});

test('backtick command substitution', async () => {
  expect((await run('echo `echo nested`')).out.trim()).toBe('nested');
});

test('command sub used in assignment', async () => {
  expect((await run('x=$(echo abc); echo $x')).out.trim()).toBe('abc');
});

// ── for / case / until / break / continue ─────────────────────────────────────

test('for loop iterates word list', async () => {
  expect((await run('for x in a b c; do echo $x; done')).out).toBe('a\nb\nc\n');
});

test('for loop over brace expansion', async () => {
  expect((await run('for i in {1..3}; do echo n$i; done')).out).toBe('n1\nn2\nn3\n');
});

test('case statement matches glob patterns', async () => {
  expect((await run('case hello in h*) echo yes ;; *) echo no ;; esac')).out.trim()).toBe('yes');
  expect((await run('case foo in a|b) echo ab ;; f*) echo f ;; esac')).out.trim()).toBe('f');
});

test('until loop', async () => {
  const { out } = await run('x=0; until [ $x -ge 3 ]; do echo $x; x=$(( x + 1 )); done');
  expect(out).toBe('0\n1\n2\n');
});

test('break exits a loop', async () => {
  const { out } = await run('for x in 1 2 3 4; do if [ $x -eq 3 ]; then break; fi; echo $x; done');
  expect(out).toBe('1\n2\n');
});

test('continue skips an iteration', async () => {
  const { out } = await run('for x in 1 2 3; do if [ $x -eq 2 ]; then continue; fi; echo $x; done');
  expect(out).toBe('1\n3\n');
});

// ── functions / local / return ────────────────────────────────────────────────

test('function definition and call with positional params', async () => {
  const { out } = await run('greet() { echo "hi $1"; }; greet world');
  expect(out.trim()).toBe('hi world');
});

test('function return sets status', async () => {
  const { out } = await run('f() { return 3; }; f; echo $?');
  expect(out.trim()).toBe('3');
});

test('local variable does not leak', async () => {
  const { out } = await run('x=outer; f() { local x=inner; echo $x; }; f; echo $x');
  expect(out).toBe('inner\nouter\n');
});

test('function keyword form', async () => {
  const { out } = await run('function add { echo $(( $1 + $2 )); }; add 2 5');
  expect(out.trim()).toBe('7');
});

// ── glob ───────────────────────────────────────────────────────────────────────

test('glob * expands against the VFS', async () => {
  const fs = mockFs({ '/a.txt': '', '/b.txt': '', '/c.log': '' });
  const { out } = await run('echo /*.txt', {}, fs);
  expect(out.trim()).toBe('/a.txt /b.txt');
});

test('unmatched glob stays literal', async () => {
  const fs = mockFs({ '/a.txt': '' });
  const { out } = await run('echo /*.zzz', {}, fs);
  expect(out.trim()).toBe('/*.zzz');
});

// ── redirects ────────────────────────────────────────────────────────────────

test('here-string feeds stdin', async () => {
  const { out } = await run('cat <<< "from heredoc"');
  expect(out.trim()).toBe('from heredoc');
});

test('here-doc feeds stdin with expansion', async () => {
  const { out } = await run('cat <<EOF\nhello $USER\nEOF', { env: { USER: 'bob' } });
  expect(out).toBe('hello bob\n');
});

test('here-doc quoted delimiter suppresses expansion', async () => {
  // eslint-disable-next-line @stylistic/quotes -- embeds single quotes for a quoted heredoc delimiter
  const { out } = await run("cat <<'EOF'\nliteral $USER\nEOF", { env: { USER: 'bob' } });
  expect(out).toBe('literal $USER\n');
});

test('2> redirects stderr to a file', async () => {
  const fs = mockFs();
  await run('nonexistent-cmd 2> /tmp/err.txt', {}, fs);
  expect(fs.files.get('/tmp/err.txt')).toContain('command not found');
});

test('input redirect from file', async () => {
  const fs = mockFs({ '/in.txt': 'file content\n' });
  const { out } = await run('cat < /in.txt', {}, fs);
  expect(out).toBe('file content\n');
});

// ── job control ───────────────────────────────────────────────────────────────

test('& backgrounds and wait collects', async () => {
  const { out, code } = await run('sleep 0 & wait');
  expect(code).toBe(0);
  expect(out).toBe('');
});

test('jobs lists background jobs', async () => {
  const { out } = await run('true & jobs');
  expect(out).toMatch(/\[1\]/);
});

// ── negation & subshell ─────────────────────────────────────────────────────

test('! negates exit status', async () => {
  expect((await run('! false; echo $?')).out.trim()).toBe('0');
  expect((await run('! true; echo $?')).out.trim()).toBe('1');
});

test('subshell isolates env', async () => {
  const { out } = await run('x=1; ( x=2; echo $x ); echo $x');
  expect(out).toBe('2\n1\n');
});

// ── [[ ]] conditional ───────────────────────────────────────────────────────

test('[[ -f ]] file test', async () => {
  const fs = mockFs({ '/exists.txt': 'x' });
  expect((await run('[[ -f /exists.txt ]]; echo $?', {}, fs)).out.trim()).toBe('0');
  expect((await run('[[ -f /missing.txt ]]; echo $?', {}, fs)).out.trim()).toBe('1');
});

test('[[ =~ ]] regex match', async () => {
  expect((await run('[[ hello123 =~ [0-9]+ ]]; echo $?')).out.trim()).toBe('0');
  expect((await run('[[ hello =~ [0-9]+ ]]; echo $?')).out.trim()).toBe('1');
});

test('[[ string == glob ]]', async () => {
  expect((await run('[[ foobar == foo* ]]; echo $?')).out.trim()).toBe('0');
});

// ── cat: coreutils-shadowing builtin (operands → spawn external) ────────────

test('cat WITH file operands spawns the external (does not use the builtin)', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { out += s; },
    resolve: (name) => name,
  });
  await ex.run(parse('cat /a.txt'));
  // The external `cat` was spawned with the file operand…
  expect(k.spawned).toHaveLength(1);
  expect(k.spawned[0].args).toEqual(['cat', '/a.txt']);
  // …and the builtin (stdin passthrough) did NOT run.
  expect(out).toBe('');
});

test('bare cat (no operands) runs the builtin stdin passthrough, no spawn', async () => {
  const k = mockKernel();
  let out = '';
  const ex = new Executor(k as any, { cwd: '/', env: {} }, {
    onStdout: (s) => { out += s; },
    resolve: (name) => name,
  });
  await ex.run(parse('echo hello | cat'));
  // Pure builtin pipeline — nothing spawned.
  expect(k.spawned).toHaveLength(0);
  expect(out).toBe('hello\n');
});

test('cat in a pipeline WITH operands spawns the external stage', async () => {
  const k = mockKernel();
  const ex = new Executor(k as any, { cwd: '/', env: {} }, { resolve: (name) => name });
  await ex.run(parse('cat /a.txt | sort'));
  // `cat /a.txt` shadows out of the builtin path, so the whole pipeline spawns.
  expect(k.spawned).toHaveLength(2);
  expect(k.spawned[0].args).toEqual(['cat', '/a.txt']);
});

// ── shift / getopts ────────────────────────────────────────────────────────

test('shift drops positional params', async () => {
  const { out } = await run('echo $1; shift; echo $1', { positional: ['a', 'b', 'c'] });
  expect(out).toBe('a\nb\n');
});
