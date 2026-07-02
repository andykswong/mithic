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

test('case ;& fallthrough runs the next clause body unconditionally', async () => {
  const { out } = await run('case a in a) echo one ;& b) echo two ;; c) echo three ;; esac');
  expect(out).toBe('one\ntwo\n');
});

test('case ;& fallthrough at the last clause runs nothing extra', async () => {
  const { out } = await run('case z in a) echo one ;; z) echo last ;& esac');
  expect(out).toBe('last\n');
});

test('case ;;& continue-matching keeps testing subsequent patterns', async () => {
  const { out } = await run('case abc in a*) echo one ;;& *c) echo two ;;& z*) echo three ;; esac');
  expect(out).toBe('one\ntwo\n');
});

test('case ;;& stops running non-matching clauses', async () => {
  const { out } = await run('case abc in a*) echo one ;;& x*) echo x ;; *) echo star ;; esac');
  expect(out).toBe('one\nstar\n');
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

test('a missing < file reports an error and CONTINUES the statement list (does not abort the script)', async () => {
  // Regression: resolving the redirect stream must not throw out of execSimple —
  // bash reports "No such file or directory", the command fails (status 1), and
  // the rest of the script still runs. Use an fs whose fsOpen throws on a missing
  // read (like the real FsClient / kernel fs/open ENOENT); mockFs above returns ''.
  const throwingFs = {
    fsOpen(path: string, flags: any): number {
      if (flags.read && path === '/nope.txt') throw new Error('ENOENT');
      return 10;
    },
    fsReadBytes() { return new Uint8Array(); },
    fsRead() { return ''; },
    fsWrite() { /* noop */ },
    fsClose() { /* noop */ },
    fsReaddir() { return []; },
    fsStat() { return undefined; },
  };
  const { out, err } = await run('echo BEFORE; cat < /nope.txt; echo "after=$?"; echo AFTER', {}, throwingFs);
  expect(err).toMatch(/nope\.txt.*No such file|No such file.*nope\.txt/);
  expect(out).toContain('BEFORE');
  expect(out).toContain('after=1'); // the failed redirect command returns 1
  expect(out).toContain('AFTER');   // the script CONTINUED past the failure
});

test('a pipe / redirect overrides an ambient exec 0<file for a plain read (not the stale fd-0 entry)', async () => {
  // Regression: `read <&N` added an fd-0 alias path for `read`. It must NOT hijack
  // a plain `read` whose real stdin is a pipe / `<` / `<<<` while fd 0 holds a
  // lingering `exec 0<file` entry. bash: the more-local stdin wins.
  const fs = mockFs({ '/f.txt': 'FILE1\n', '/r.txt': 'REDIR1\n' });
  const piped = await run('exec 0< /f.txt; printf "PIPED\\n" | { read x; echo "x=$x"; }', {}, fs);
  expect(piped.out.trim()).toBe('x=PIPED');           // the pipe wins, not FILE1
  const redir = await run('exec 0< /f.txt; read x < /r.txt; echo "x=$x"', {}, mockFs({ '/f.txt': 'FILE1\n', '/r.txt': 'REDIR1\n' }));
  expect(redir.out.trim()).toBe('x=REDIR1');          // the per-command < wins
  const herestr = await run('exec 0< /f.txt; read x <<< "HERESTR"; echo "x=$x"', {}, mockFs({ '/f.txt': 'FILE1\n' }));
  expect(herestr.out.trim()).toBe('x=HERESTR');       // the here-string wins
});

test('nested <& on fd 0 does not clobber an outer group alias (depth-counted stdinDupFds)', async () => {
  // Regression (re-review): `{ read a <&4; read b; } <&3` — the outer group aliases
  // fd 0→fd 3; the inner `read a <&4` aliases fd 0→fd 4 for THAT command only. When
  // the inner command restores, it must NOT tear down the outer group's fd-0 alias:
  // `read b` must still read from fd 3. A flat Set clobbered it (b came back empty);
  // a depth-counted Map keeps the outer alias live. bash: a=FOUR b=THREE_A.
  const fs = mockFs({ '/f3.txt': 'THREE_A\nTHREE_B\n', '/f4.txt': 'FOUR\n' });
  const { out } = await run('exec 3< /f3.txt; exec 4< /f4.txt; { read a <&4; read b; echo "a=$a b=$b"; } <&3', {}, fs);
  expect(out.trim()).toBe('a=FOUR b=THREE_A');
});

test('read -n over a <&N/-u N fd reads the whole line (documented limitation lock — KNOWN_LIMITATIONS)', async () => {
  // Locks the documented limit: -n/-d is ignored over a numbered/dup fd (whole
  // line/datagram returned), while over a here-string it IS honored. If this ever
  // changes it should be a conscious, test-visible decision.
  const fs = mockFs({ '/data.txt': 'ABCDEF\n' });
  const overFd = await run('exec 3< /data.txt; read -n2 a <&3; echo "a=$a"', {}, fs);
  expect(overFd.out.trim()).toBe('a=ABCDEF');          // -n2 IGNORED over an fd (whole line)
  const overHereStr = await run('read -n2 a <<< "ABCDEF"; echo "a=$a"');
  expect(overHereStr.out.trim()).toBe('a=AB');         // -n2 HONORED over a here-string
});

test('read <&3 on an unopened fd reads nothing (rc 1), does not crash', async () => {
  // Bad-fd branch: no `exec 3<…` first, so fd 3 has no entry — the <& alias finds
  // no source, the guard does not fire, and the plain read hits EOF (rc 1).
  const { out } = await run('read a <&3; echo "rc=$? a=[$a]"');
  expect(out.trim()).toBe('rc=1 a=[]');
});

// ── byte-stream stdin: streaming builtins over a shared cursor ────────────────

test('cat streams a here-string through unchanged', async () => {
  const { out } = await run('cat <<< "hello world"');
  expect(out).toBe('hello world\n');
});

test('read -n3 reads exactly 3 chars from a here-string', async () => {
  const { out } = await run('read -n3 x <<< "abcdef"; echo "$x"');
  expect(out.trim()).toBe('abc');
});

test('mapfile reads all lines from a here-doc into an array', async () => {
  const { out } = await run('mapfile -t arr <<EOF\na\nb\nc\nEOF\necho "${arr[1]}"');
  expect(out.trim()).toBe('b');
});

// ── job control ───────────────────────────────────────────────────────────────

test('& backgrounds and wait collects', async () => {
  const { out, code } = await run('sleep 0 & wait');
  expect(code).toBe(0);
  expect(out).toBe('');
});

test('backgrounded prefix-external RHS expands ONCE on a no-spawnStream backend', async () => {
  // Regression: `x=$(sub) realcmd &` — on a backend WITHOUT spawnStream the job
  // runs via the in-process fallback (execStatement→execSimple). Previously the
  // command was ALSO expanded eagerly by backgroundExternal, so the RHS `$(sub)`
  // ran TWICE. The fix gates backgroundExternal behind spawnStream. Count how many
  // times `sub` is spawned (the command substitution runs `sub` as an external).
  const spawned: any[] = [];
  const k = { // NO spawnStream → forces the in-process fallback
    spawned,
    async spawn(args: any) { spawned.push(args); return { pid: spawned.length }; },
    async wait(pid: number) { return { pid, code: 0 }; },
  };
  const ex = new (await import('./executor.ts')).Executor(k as any, { cwd: '/', env: {} } as any, {
    onStdout: () => {}, onStderr: () => {}, resolve: (n: string) => n,
  });
  await ex.run(parse('x=$(sub) realcmd & wait'));
  const subSpawns = spawned.filter((s) => (s.args?.[0] ?? s.code) === 'sub').length;
  expect(subSpawns).toBe(1); // the command substitution ran exactly once
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

// ── set options: -u / -x / -o pipefail / noclobber / $- ─────────────────────

test('set -u (nounset): expanding an unset var errors and aborts nonzero', async () => {
  const { code, err } = await run('set -u; echo $UNDEFINED_VAR; echo after');
  expect(code).not.toBe(0);
  expect(err).toMatch(/UNDEFINED_VAR/);
});

test('set -u allows set vars and ${var:-default}', async () => {
  expect((await run('set -u; X=hi; echo $X')).out.trim()).toBe('hi');
  expect((await run('set -u; echo ${MISSING:-fallback}')).out.trim()).toBe('fallback');
});

test('set +u re-enables unset expansion to empty', async () => {
  const { out, code } = await run('set -u; set +u; echo "[$NOPE]"');
  expect(code).toBe(0);
  expect(out.trim()).toBe('[]');
});

test('set -x (xtrace): prints each command to stderr prefixed with +', async () => {
  const { out, err } = await run('set -x; echo hello');
  expect(out.trim()).toBe('hello');
  expect(err).toContain('+ echo hello');
});

test('set -o pipefail: pipeline status is the last NONZERO stage', async () => {
  // false | true: without pipefail the status is the last stage (0). With
  // pipefail it is the last nonzero stage (1).
  expect((await run('false | true; echo $?')).out.trim()).toBe('0');
  expect((await run('set -o pipefail; false | true; echo $?')).out.trim()).toBe('1');
});

test('set -o pipefail: all-zero pipeline still returns 0', async () => {
  expect((await run('set -o pipefail; true | true; echo $?')).out.trim()).toBe('0');
});

test('set -euo pipefail: `o` in a flag cluster consumes the following long-option name', async () => {
  // The canonical strict-mode preamble. `-euo pipefail` == `-e -u -o pipefail`:
  // `o` introduces a long option taking the NEXT word, even mid-cluster.
  const { code } = await run('set -euo pipefail; echo "[$-]"; set -o');
  expect(code).toBe(0);
  const { out } = await run('set -euo pipefail; set -o');
  expect(out).toMatch(/pipefail\s+on/);
  expect(out).toMatch(/errexit\s+on/);
  expect(out).toMatch(/nounset\s+on/);
});

test('set +euo pipefail: cluster with `o` also DISABLES the named option', async () => {
  const { out } = await run('set -euo pipefail; set +euo pipefail; set -o');
  expect(out).toMatch(/pipefail\s+off/);
  expect(out).toMatch(/errexit\s+off/);
  expect(out).toMatch(/nounset\s+off/);
});

test('set -euo with an unknown long-option name errors (no silent accept)', async () => {
  const { code, err } = await run('set -euo bogus; echo after');
  expect(code).not.toBe(0);
  expect(err).toMatch(/bogus/);
});

test('noclobber: > refuses to overwrite an existing file; >| forces', async () => {
  const fs = mockFs({ '/exists.txt': 'old\n' });
  const r1 = await run('set -C; echo new > /exists.txt; echo "rc=$?"', {}, fs);
  expect(r1.out.trim()).toBe('rc=1');
  expect(fs.files.get('/exists.txt')).toBe('old\n'); // untouched
  const r2 = await run('set -C; echo new >| /exists.txt; echo done', {}, fs);
  expect(fs.files.get('/exists.txt')).toBe('new\n'); // forced overwrite
  expect(r2.code).toBe(0);
});

test('noclobber: > to a NEW file still works', async () => {
  const fs = mockFs();
  await run('set -C; echo fresh > /new.txt', {}, fs);
  expect(fs.files.get('/new.txt')).toBe('fresh\n');
});

test('$- reflects enabled short flags', async () => {
  const { out } = await run('set -eux; echo "[$-]"');
  // Order is canonical (e, u, x). The xtrace line also prints to stderr.
  expect(out).toMatch(/\[.*e.*u.*x.*\]/);
});

test('set -o lists option states', async () => {
  const { out } = await run('set -o pipefail; set -o');
  expect(out).toMatch(/pipefail\s+on/);
  expect(out).toMatch(/nounset\s+off/);
});

// ── G1: select ────────────────────────────────────────────────────────────

test('select picks the item by piped index and runs the body', async () => {
  const { out } = await run('printf "2\\n" | select x in alpha beta gamma; do echo "got:$x"; break; done');
  expect(out).toContain('got:beta');
});

test('select sets $REPLY to the raw input and loops until EOF', async () => {
  // Two selections then EOF; each iteration prints the chosen value + REPLY.
  const { out } = await run('printf "1\\n3\\n" | select x in a b c; do echo "$REPLY=>$x"; done');
  expect(out).toContain('1=>a');
  expect(out).toContain('3=>c');
});

test('select prints the numbered menu and PS3 prompt to stderr', async () => {
  const { err } = await run('printf "1\\n" | select x in one two; do break; done', { env: { PS3: 'pick> ' } });
  expect(err).toContain('1) one');
  expect(err).toContain('2) two');
  expect(err).toContain('pick> ');
});

test('select with an out-of-range index sets the var empty but still runs the body', async () => {
  const { out } = await run('printf "9\\n" | select x in a b; do echo "[$x]"; break; done');
  expect(out).toContain('[]');
});

test('select reads choices from a < redirect', async () => {
  const fs = mockFs({ '/sel.in': '2\n' });
  const { out } = await run('select x in red green blue; do echo "$x"; break; done < /sel.in', {}, fs);
  expect(out.trim()).toBe('green');
});

test('select with no input (EOF) runs the body zero times', async () => {
  const { out } = await run('printf "" | select x in a b c; do echo "ran:$x"; done');
  expect(out).not.toContain('ran:');
});

test('break exits the select loop', async () => {
  const { out } = await run('printf "1\\n1\\n1\\n" | select x in a b; do echo "$x"; break; done');
  // Only one iteration despite three lines of input.
  expect(out.trim()).toBe('a');
});

// ── A2: coproc (now implemented; gated on a transferable backend) ────────────
// The mock kernel here has no `spawnCoproc`, modelling a non-transferable
// backend — so coproc emits the PRECISE backend-gating diagnostic (not the old
// blanket "not supported in this runtime", and not command-not-found).

test('coproc on a non-transferable backend emits the precise diagnostic, non-zero exit', async () => {
  const { err, code } = await run('coproc mycmd { echo hi; }');
  expect(err).toContain('coproc: requires a transferable backend');
  expect(err).not.toContain('not supported in this runtime');
  expect(err).not.toContain('command not found');
  expect(code).not.toBe(0);
});

test('bare coproc is also diagnosed, not 127 command-not-found', async () => {
  const { err } = await run('coproc');
  expect(err).toContain('coproc: requires a transferable backend');
});

// ── indexed arrays ──────────────────────────────────────────────────────────

test('array literal + element access ${arr[0]}', async () => {
  const { out } = await run('arr=(a b c); echo ${arr[0]} ${arr[1]} ${arr[2]}');
  expect(out.trim()).toBe('a b c');
});

test('bare $arr expands to element 0', async () => {
  expect((await run('arr=(x y z); echo $arr')).out.trim()).toBe('x');
});

test('${arr[@]} expands to all elements (word-split)', async () => {
  const { out } = await run('arr=(one two three); for x in ${arr[@]}; do echo $x; done');
  expect(out).toBe('one\ntwo\nthree\n');
});

test('"${arr[@]}" preserves elements with spaces as separate words', async () => {
  const { out } = await run('arr=(a b c); echo "${arr[@]}"');
  expect(out.trim()).toBe('a b c');
});

test('${arr[*]} joins all elements', async () => {
  expect((await run('arr=(a b c); echo "${arr[*]}"')).out.trim()).toBe('a b c');
});

test('${#arr[@]} is the element count', async () => {
  expect((await run('arr=(a b c d); echo ${#arr[@]}')).out.trim()).toBe('4');
});

test('${#arr[1]} is the length of one element', async () => {
  expect((await run('arr=(a bb ccc); echo ${#arr[1]}')).out.trim()).toBe('2');
});

test('${!arr[@]} lists the indices', async () => {
  expect((await run('arr=(a b c); echo ${!arr[@]}')).out.trim()).toBe('0 1 2');
});

test('element assignment arr[2]=x', async () => {
  const { out } = await run('arr=(a b c); arr[1]=B; echo ${arr[0]} ${arr[1]} ${arr[2]}');
  expect(out.trim()).toBe('a B c');
});

test('append arr+=(d e)', async () => {
  const { out } = await run('arr=(a b); arr+=(c d); echo ${arr[@]}; echo ${#arr[@]}');
  expect(out).toBe('a b c d\n4\n');
});

test('array element via expansion index ${arr[$i]}', async () => {
  expect((await run('arr=(a b c); i=2; echo ${arr[$i]}')).out.trim()).toBe('c');
});

test('out-of-range element is empty', async () => {
  expect((await run('arr=(a b); echo "[${arr[9]}]"')).out.trim()).toBe('[]');
});

// ── ${!var} indirection ─────────────────────────────────────────────────────

test('${!var} indirect expansion (value of the variable named by var)', async () => {
  const { out } = await run('target=hello; ref=target; echo ${!ref}');
  expect(out.trim()).toBe('hello');
});

test('${!var} with an unset indirection is empty', async () => {
  expect((await run('ref=nope; echo "[${!ref}]"')).out.trim()).toBe('[]');
});

// ── readonly enforcement (non-POSIX: reports + continues, keeps old value) ────

test('readonly var rejects reassignment (non-posix: reports, keeps old value, continues)', async () => {
  const { out, err } = await run('readonly RO=1; RO=2; echo "$RO"');
  expect(out.trim()).toBe('1');
  expect(err).toMatch(/RO: readonly variable/);
});

test('readonly without = marks an existing var readonly', async () => {
  const { out, err } = await run('X=1; readonly X; X=2; echo "$X"');
  expect(out.trim()).toBe('1');
  expect(err).toMatch(/X: readonly variable/);
});

test('readonly NAME=val sets the value (first assignment succeeds)', async () => {
  const { out } = await run('readonly RO=hello; echo "$RO"');
  expect(out.trim()).toBe('hello');
});

test('unset of a readonly var is rejected (keeps the value, status 1)', async () => {
  const { out, err } = await run('readonly RO=1; unset RO; echo "$RO $?"');
  expect(out.trim()).toBe('1 1');
  expect(err).toMatch(/cannot unset: readonly variable/);
});

test('export/declare reassignment of a readonly var is rejected', async () => {
  const exp = await run('readonly RO=1; export RO=2; echo "$RO"');
  expect(exp.out.trim()).toBe('1');
  expect(exp.err).toMatch(/RO: readonly variable/);
  const dec = await run('readonly RO=1; declare RO=2; echo "$RO"');
  expect(dec.out.trim()).toBe('1');
  expect(dec.err).toMatch(/RO: readonly variable/);
});

test('writing through a nameref to a readonly target is rejected', async () => {
  const { out, err } = await run('target=1; readonly target; declare -n ref=target; ref=2; echo "$target"');
  expect(out.trim()).toBe('1');
  expect(err).toMatch(/target: readonly variable/);
});

test('${var:=x} default-assign on a readonly var warns, skips write, yields the word, and continues', async () => {
  // bash 3.2/5.x: prints `v: readonly variable`, leaves v UNSET, the expansion
  // still yields `hi`, and the script continues (exit 0) — non-fatal even in posix.
  const { out, err, code } = await run('readonly v; printf "[%s]" "${v:=hi}"; echo " v=[$v]"');
  expect(out.trim()).toBe('[hi] v=[]');
  expect(err).toMatch(/v: readonly variable/);
  expect(code).toBe(0);
});

test('${var=x} (no-colon) default-assign on a readonly var also warns + skips + continues', async () => {
  const { out, err, code } = await run('readonly v; printf "[%s]" "${v=hi}"; echo " v=[$v]"');
  expect(out.trim()).toBe('[hi] v=[]');
  expect(err).toMatch(/v: readonly variable/);
  expect(code).toBe(0);
});

// ── arithmetic (( )) / for (( )) / let must not overwrite a readonly var ──────

test('(( x = 5 )) on a readonly var warns, does NOT write, and continues', async () => {
  // bash: prints the readonly warning, does not write x, but the expression's
  // value (5, nonzero) still makes (( )) succeed; the script continues.
  const { out, err, code } = await run('readonly x; (( x = 5 )); echo "x=[$x] $?"');
  expect(out.trim()).toBe('x=[] 0');
  expect(err).toMatch(/x: readonly variable/);
  expect(code).toBe(0);
});

test('let x=5 on a readonly var warns and does not write', async () => {
  const { out, err } = await run('readonly x; let x=5; echo "x=[$x]"');
  expect(out.trim()).toBe('x=[]');
  expect(err).toMatch(/x: readonly variable/);
});

test('for ((x=0;x<2;x++)) on a readonly counter TERMINATES (does not hang) and warns', async () => {
  // Deliberate divergence from bash, which infinite-loops here (the readonly
  // counter never advances). mithic is SAFER: it warns, skips the write, and
  // breaks the loop so it terminates promptly.
  const start = Date.now();
  const { err, code } = await run('readonly x; for ((x=0;x<2;x++)); do echo iter; done; echo after');
  expect(Date.now() - start).toBeLessThan(2000); // must not spin to the 1M guard
  expect(err).toMatch(/x: readonly variable/);
  expect(code).toBe(0);
});

test('for (( )) over a non-readonly counter still iterates normally', async () => {
  const { out, code } = await run('for ((i=0;i<3;i++)); do echo $i; done');
  expect(out.trim().split('\n')).toEqual(['0', '1', '2']);
  expect(code).toBe(0);
});

// ── let (arithmetic-evaluation builtin) ──────────────────────────────────────

test('let evaluates arithmetic and assigns', async () => {
  const { out } = await run('let "x = 2 + 3"; echo $x');
  expect(out.trim()).toBe('5');
});

test('let exit status is 1 when the last expr is 0, 0 otherwise', async () => {
  expect((await run('let "0"; echo $?')).out.trim()).toBe('1');
  expect((await run('let "1"; echo $?')).out.trim()).toBe('0');
});

test('let multiple expressions take status from the last', async () => {
  // last expr (b=0) evaluates to 0 → status 1, but both assignments take.
  const { out } = await run('let "a=1" "b=0"; echo "$a $b $?"');
  expect(out.trim()).toBe('1 0 1');
});

test('let with a malformed expression fails the command (status 2), not the script', async () => {
  // A bad arith expr is a per-command error: status 2 + diagnostic, and the NEXT
  // statement still runs (vs aborting the whole script).
  const { out, err } = await run('let "1 +"; echo AFTER=$?');
  expect(out.trim()).toBe('AFTER=2');
  expect(err).toMatch(/let:/);
});

test('let division by zero fails the command, not the script', async () => {
  const { out } = await run('let "1 / 0"; echo STILL_RUNS');
  expect(out).toContain('STILL_RUNS');
});

// ── declare -n namerefs (single-level) ───────────────────────────────────────

test('declare -n nameref reads through to the target', async () => {
  const { out } = await run('target=hi; declare -n ref=target; echo $ref');
  expect(out.trim()).toBe('hi');
});

test('assigning through a nameref writes the target', async () => {
  const { out } = await run('target=1; declare -n ref=target; ref=2; echo $target');
  expect(out.trim()).toBe('2');
});

test('${ref:=x} default-assign through a nameref writes the target, not the ref name', async () => {
  // target unset; `${ref:=hi}` must assign `target`, so `$target` and `$ref`
  // both read `hi` afterwards.
  const { out } = await run('declare -n ref=target; : "${ref:=hi}"; echo "$target"; echo "$ref"');
  expect(out.trim().split('\n')).toEqual(['hi', 'hi']);
});

test('${ref@A} on a nameref reconstructs declare -n ref=target (target NAME, not value) — real Environment', async () => {
  // Regression: this must run through the REAL Environment.resolveNameref, not a
  // test mock. Before the fix, @A emitted the target's VALUE (declare -n ref=hi).
  const { out } = await run('target=hi; declare -n ref=target; echo "${ref@A}"');
  expect(out.trim()).toBe('declare -n ref=target');
});

test('${x@A} on a plain scalar reconstructs a double-quoted declare — real Environment', async () => {
  const { out } = await run('x="a b"; echo "${x@A}"');
  expect(out.trim()).toBe('declare -- x="a b"');
});

// ── A8: ${var@a} attribute-flags transform ───────────────────────────────────

test('${var@a} reports readonly (r), nameref (n), indexed (a) and associative (A) flags', async () => {
  const { out } = await run([
    'ro=1; readonly ro;',
    'declare -n ref=ro;',
    'idx=(x y);',
    'declare -A m;',
    'plain=hi;',
    'echo "[${ro@a}][${ref@a}][${idx@a}][${m@a}][${plain@a}]"',
  ].join(' '));
  expect(out.trim()).toBe('[r][n][a][A][]');
});

// ── dirs / pushd / popd directory stack ──────────────────────────────────────

test('pushd/dirs/popd manage the directory stack', async () => {
  const { out } = await run('cd /a; pushd /b; dirs; popd; dirs; pwd', { cwd: '/' });
  // pushd prints "/b /a"; dirs prints "/b /a"; popd prints "/a"; dirs prints "/a"; pwd "/a"
  expect(out.trim().split('\n')).toEqual(['/b /a', '/b /a', '/a', '/a', '/a']);
});

test('pushd with no arg swaps the top two', async () => {
  const { out } = await run('cd /a; pushd /b; pushd; pwd', { cwd: '/' });
  // after pushd /b: stack "/b /a" (cwd /b); bare pushd swaps → "/a /b" (cwd /a)
  expect(out.trim().split('\n')).toEqual(['/b /a', '/a /b', '/a']);
});

test('dirs -c clears the stack', async () => {
  const { out } = await run('cd /a; pushd /b; dirs -c; dirs', { cwd: '/' });
  expect(out.trim().split('\n')).toEqual(['/b /a', '/b']);
});

test('dirs abbreviates $HOME with ~ unless -l', async () => {
  const { out } = await run('cd /home/u; dirs; dirs -l', { cwd: '/', env: { HOME: '/home/u' } });
  expect(out.trim().split('\n')).toEqual(['~', '/home/u']);
});

// ── A4: pushd/popd +N/-N directory-stack rotation ────────────────────────────
// Build dirs = "/a /b /c" by pushing in reverse: cwd ends at /a, stack = [/b, /c].

test('pushd +1 rotates the directory stack left by 1', async () => {
  const { out } = await run('cd /c; pushd /b; pushd /a; pushd +1; pwd', { cwd: '/' });
  // pushd /b → "/b /c"; pushd /a → "/a /b /c"; pushd +1 → "/b /c /a"; pwd → /b
  expect(out.trim().split('\n')).toEqual(['/b /c', '/a /b /c', '/b /c /a', '/b']);
});

test('pushd -0 rotates so the last entry becomes the top', async () => {
  const { out } = await run('cd /c; pushd /b; pushd /a; pushd -0; pwd', { cwd: '/' });
  // dirs "/a /b /c"; -0 = last (/c) → top → "/c /a /b"; pwd → /c
  expect(out.trim().split('\n')).toEqual(['/b /c', '/a /b /c', '/c /a /b', '/c']);
});

test('popd +1 removes the entry at index 1 (cwd unchanged)', async () => {
  const { out } = await run('cd /c; pushd /b; pushd /a; popd +1; pwd', { cwd: '/' });
  // dirs "/a /b /c"; popd +1 removes /b → "/a /c"; pwd → /a (unchanged)
  expect(out.trim().split('\n')).toEqual(['/b /c', '/a /b /c', '/a /c', '/a']);
});

test('popd +0 removes the current dir (top) and cds to the next', async () => {
  const { out } = await run('cd /c; pushd /b; pushd /a; popd +0; pwd', { cwd: '/' });
  // dirs "/a /b /c"; popd +0 removes /a → cwd=/b → "/b /c"; pwd → /b
  expect(out.trim().split('\n')).toEqual(['/b /c', '/a /b /c', '/b /c', '/b']);
});

test('pushd +9 out of range reports an error and leaves the stack unchanged', async () => {
  const { out, err } = await run('cd /c; pushd /b; pushd /a; pushd +9; pwd', { cwd: '/' });
  expect(err).toMatch(/directory stack index out of range/);
  // No rotation: pwd stays /a.
  expect(out.trim().split('\n')).toEqual(['/b /c', '/a /b /c', '/a']);
});

// ── WP-E: ANSI-C quoting, line continuation, nested quotes, DEBUG/RETURN traps ─

test('$\'...\' ANSI-C quoting expands \\t \\n \\xHH', async () => {
  expect((await run('echo $\'a\\tb\'')).out).toBe('a\tb\n');
  expect((await run('echo $\'x\\ny\'')).out).toBe('x\ny\n');
  expect((await run('echo $\'\\x41\\x42\'')).out).toBe('AB\n');
  // $'...' inside double quotes is NOT special (literal), matching bash.
  expect((await run('echo "$\'a\\tb\'"')).out).toBe('$\'a\\tb\'\n');
});

test('$"..." locale quoting drops the $ and expands normally', async () => {
  expect((await run('x=5; echo $"v=$x"')).out).toBe('v=5\n');
});

test('backslash-newline is a line continuation (word splice)', async () => {
  expect((await run('x=a\\\ndef; echo "$x"')).out).toBe('adef\n');
  // inside double quotes too
  expect((await run('echo "a\\\nb"')).out).toBe('ab\n');
});

test('nested double-quotes inside "$(...)" is one word', async () => {
  expect((await run('echo "[$(echo "a b")]"')).out).toBe('[a b]\n');
});

test(';& case fallthrough runs the next clause body; ;;& continues matching', async () => {
  expect((await run('case a in a) echo one ;& b) echo two ;; esac')).out).toBe('one\ntwo\n');
  // ;; (no fallthrough) stops after the first match
  expect((await run('case a in a) echo one ;; b) echo two ;; esac')).out).toBe('one\n');
  // ;;& re-tests subsequent patterns
  expect((await run('case ab in a*) echo A ;;& *b) echo B ;; esac')).out).toBe('A\nB\n');
});

test('DEBUG trap fires before each simple command', async () => {
  expect((await run('trap \'echo D\' DEBUG; :; :')).out).toBe('D\nD\n');
});

test('RETURN trap fires when a function returns', async () => {
  expect((await run('f() { trap \'echo TRAP\' RETURN; }; f; echo after')).out).toBe('TRAP\nafter\n');
});

// ── WP-C: declare -i, array-element arithmetic, ! in arithmetic ─────────────

test('declare -i evaluates assignments arithmetically', async () => {
  expect((await run('declare -i n=5; n=n+3; echo $n')).out).toBe('8\n');
  expect((await run('declare -i n=5; n+=10; echo $n')).out).toBe('15\n');
  expect((await run('declare -i x=2#101; echo $x')).out).toBe('5\n');
  // a non-integer var still string-concatenates on +=
  expect((await run('s=1; s+=0; echo $s')).out).toBe('10\n');
});

test('array-element arithmetic inside (( ))', async () => {
  expect((await run('a=(1 2 3); ((a[1]+=10)); echo ${a[1]}')).out).toBe('12\n');
  expect((await run('a=(5); ((a[0]++)); echo ${a[0]}')).out).toBe('6\n');
});

test('logical NOT usable in arithmetic (history expansion off for non-interactive)', async () => {
  expect((await run('echo $((!0))')).out).toBe('1\n');
  expect((await run('echo $((!5))')).out).toBe('0\n');
  expect((await run('x=0; echo $((!x))')).out).toBe('1\n');
});

test('base#num arithmetic literals through the shell', async () => {
  expect((await run('echo $((16#ff))')).out).toBe('255\n');
  expect((await run('echo $((2#1010))')).out).toBe('10\n');
  expect((await run('echo $((0xFFFFFFFF))')).out).toBe('4294967295\n');
});

// ── WP-D: test operators, command/builtin, type -t/-a, declare -p, special vars ─

test('test/[ ] -a/-o operators and 3-arg negation', async () => {
  expect((await run('[ -n a -a -n b ] && echo yes || echo no')).out).toBe('yes\n');
  expect((await run('[ -z "" -o -n b ] && echo yes')).out).toBe('yes\n');
  expect((await run('[ 1 -eq 1 -a 2 -eq 2 ] && echo y')).out).toBe('y\n');
  expect((await run('[ -n a -a -z b ] && echo yes || echo no')).out).toBe('no\n');
  expect((await run('[ ! -z "hello" ] && echo nonempty')).out).toBe('nonempty\n');
  expect((await run('[ ! -n "" ] && echo isempty')).out).toBe('isempty\n');
});

test('test/[ ] lexical </> and [[ ]] lexical </>', async () => {
  expect((await run('[ apple \\< banana ] && echo ordered')).out).toBe('ordered\n');
  expect((await run('[ banana \\> apple ] && echo ok')).out).toBe('ok\n');
  expect((await run('[[ apple < banana ]] && echo ordered')).out).toBe('ordered\n');
  expect((await run('[[ banana > apple ]] && echo yes')).out).toBe('yes\n');
});

test('command [-v] and builtin bypass functions', async () => {
  expect((await run('command -v echo')).out).toBe('echo\n');
  expect((await run('command echo hi')).out).toBe('hi\n');
  expect((await run('builtin echo hi')).out).toBe('hi\n');
  // `nonexistent*` is unresolvable in this harness's resolve() stub.
  expect((await run('command -v nonexistentcmd; echo "rc=$?"')).out).toBe('rc=1\n');
  expect((await run('echo(){ printf FUNC; }; command echo hi')).out).toBe('hi\n');
});

test('type -t classifies keyword/function/builtin', async () => {
  expect((await run('type -t echo')).out).toBe('builtin\n');
  expect((await run('type -t if')).out).toBe('keyword\n');
  expect((await run('f(){ :;}; type -t f')).out).toBe('function\n');
  expect((await run('type -t nosuch; echo "rc=$?"')).out).toBe('rc=1\n');
});

test('declare -p reconstructs scalars and arrays', async () => {
  expect((await run('declare -r y=5; declare -p y')).out).toBe('declare -r y="5"\n');
  expect((await run('a=(1 2 3); declare -p a')).out).toBe('declare -a a=([0]="1" [1]="2" [2]="3")\n');
});

test('$FUNCNAME reflects the call stack', async () => {
  expect((await run('f(){ echo "$FUNCNAME"; }; f')).out).toBe('f\n');
  expect((await run('g(){ echo "${FUNCNAME[0]} ${FUNCNAME[1]}"; }; h(){ g; }; h')).out).toBe('g h\n');
  expect((await run('echo "[$FUNCNAME]"')).out).toBe('[]\n'); // empty outside a function
});

test('BASH_REMATCH is populated after [[ =~ ]] with groups', async () => {
  expect((await run('[[ abc123 =~ ([a-z]+)([0-9]+) ]] && echo "${BASH_REMATCH[0]}/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"')).out)
    .toBe('abc123/abc/123\n');
});

test('$_ is the last argument of the previous command; $SECONDS is numeric', async () => {
  expect((await run('echo abc def; echo "$_"')).out).toBe('abc def\ndef\n');
  expect((await run('echo "${SECONDS}"')).out).toBe('0\n');
});

// ── Review-found regressions (fixed) ─────────────────────────────────────────

test('[ "!" = "!" ] is a binary equality (not negation) — 3-arg binary wins over !', async () => {
  expect((await run('[ "!" = "!" ] && echo yes || echo no')).out).toBe('yes\n');
  expect((await run('[ "(" = "(" ] && echo yes || echo no')).out).toBe('yes\n');
});

test('${arr[0]:1:3} substrings the element (not the whole element)', async () => {
  expect((await run('arr=(hello world); echo "${arr[0]:1:3}"')).out).toBe('ell\n');
  expect((await run('arr=(hello world); echo "${arr[1]:0:2}"')).out).toBe('wo\n');
});

test('read -a with trailing IFS delimiter does not produce a spurious empty field', async () => {
  expect((await run('IFS=: read -a arr <<< "a:b:"; echo ${#arr[@]}')).out).toBe('2\n');
});

// ── Review round 2 regressions (fixed) ───────────────────────────────────────

test('printf %b escaped-backslash before c does not trigger \\c output-stop', async () => {
  // 'hello\\cworld' (literal backslash-backslash-c) → %b: \\ = \, then cworld
  expect((await run('printf \'%b\' \'hello\\\\cworld\'; echo END')).out).toBe('hello\\cworldEND\n');
  // a real \c DOES stop
  expect((await run('printf \'%b\' \'hello\\cworld\'; echo END')).out).toBe('helloEND\n');
});

test('command -v resolves shell keywords', async () => {
  expect((await run('command -v if')).out).toBe('if\n');
  expect((await run('command -v while')).out).toBe('while\n');
  expect((await run('command -v case')).out).toBe('case\n');
});

test('$\'...\' with an escaped single-quote (\\\') yields a literal quote', async () => {
  expect((await run('echo $\'can\\\'t\'')).out).toBe('can\'t\n');
  // printf %b keeps \' literal (NOT an escape there) — the ansiC flag is $'…'-only
  expect((await run('printf \'%b\' \'x\\\'y\'')).out).toBe('x\\y');
});

// ── type / command $PATH resolution (bash-parity for external commands) ───────

/** A PATH-seeded FS: /bin/ls, /bin/echo, /usr/bin/cat as regular files. */
function pathFs() {
  return mockFs({ '/bin/ls': '', '/bin/echo': '', '/usr/bin/cat': '' });
}
const PATHENV = { env: { PATH: '/bin:/usr/bin' } };

test('type -a / -t / -p report a $PATH executable', async () => {
  expect((await run('type -a ls', PATHENV, pathFs())).out).toBe('ls is /bin/ls\n');
  expect((await run('type -t ls', PATHENV, pathFs())).out).toBe('file\n');
  expect((await run('type -p ls', PATHENV, pathFs())).out).toBe('/bin/ls\n');
  expect((await run('type ls', PATHENV, pathFs())).out).toBe('ls is /bin/ls\n');
});

test('type -a lists a builtin AND its $PATH file (builtin first)', async () => {
  // `echo` is a builtin and also present at /bin/echo.
  expect((await run('type -a echo', PATHENV, pathFs())).out)
    .toBe('echo is a shell builtin\necho is /bin/echo\n');
});

test('type of a $PATH command that is also a keyword/function prefers those first', async () => {
  expect((await run('type -t if', PATHENV, pathFs())).out).toBe('keyword\n');
});

test('type NAME not found → stderr + rc 1 (empty/absent PATH)', async () => {
  expect((await run('type -t nosuch; echo "rc=$?"', PATHENV, pathFs())).out).toBe('rc=1\n');
  const miss = await run('type nosuch', PATHENV, pathFs());
  expect(miss.err).toMatch(/nosuch: not found/);
  expect(miss.code).toBe(1);
  // Empty PATH ⇒ no search dirs ⇒ a real file name is still not found.
  expect((await run('type -t ls; echo "rc=$?"', { env: { PATH: '' } }, pathFs())).out).toBe('rc=1\n');
});

test('command -v / -V report a $PATH executable path (not the bare name)', async () => {
  expect((await run('command -v ls', PATHENV, pathFs())).out).toBe('/bin/ls\n');
  expect((await run('command -V ls', PATHENV, pathFs())).out).toBe('ls is /bin/ls\n');
  // builtin: -v prints the name, -V the description.
  expect((await run('command -v echo', PATHENV, pathFs())).out).toBe('echo\n');
  expect((await run('command -V echo', PATHENV, pathFs())).out).toBe('echo is a shell builtin\n');
  // keyword.
  expect((await run('command -V if', PATHENV, pathFs())).out).toBe('if is a shell keyword\n');
  // genuine miss: silent, rc 1.
  const miss = await run('command -v nosuch; echo "rc=$?"', PATHENV, pathFs());
  expect(miss.out).toBe('rc=1\n');
});

test('array-element references work in let / declare -i / C-style for arithmetic', async () => {
  expect((await run('a=(5 9); let "x = a[1] + 1"; echo $x')).out).toBe('10\n');
  expect((await run('a=(5 9); declare -i x=a[1]+1; echo $x')).out).toBe('10\n');
  expect((await run('a=(3); for ((i=a[0]; i<5; i++)); do printf "%s " "$i"; done')).out).toBe('3 4 ');
});

test('array subscripts are arithmetic (${a[i]}, ${a[b[0]]}, a[i]=v)', async () => {
  expect((await run('a=(x y z); i=1; echo "${a[i]}"')).out).toBe('y\n');
  expect((await run('a=(x y z); i=1; echo "${a[i+1]}"')).out).toBe('z\n');
  expect((await run('a=(x y z); b=(2 0); echo "${a[b[0]]}"')).out).toBe('z\n'); // nested: a[b[0]]=a[2]
  expect((await run('a=(x y z); i=1; a[i]=Q; echo "${a[1]}"')).out).toBe('Q\n');
  expect((await run('a=(x y z); i=1; a[i+1]=W; echo "${a[2]}"')).out).toBe('W\n');
});

test('combined declare/local flags (-ri, -ir, -rx) apply BOTH attributes', async () => {
  // -ri = readonly + integer: RHS is arith-evaluated AND reassignment is rejected.
  expect((await run('declare -ri n=2+3; echo "$n"; n=9; echo "$n"')).out).toBe('5\n5\n');
  expect((await run('declare -ir n=10; n=20; echo "$n"')).err).toMatch(/readonly/);
  // local -ri inside a function.
  expect((await run('f(){ local -ri x=5; x=6; echo "$x"; }; f')).out).toBe('5\n');
  // -rx = readonly + export.
  expect((await run('declare -rx Z=hi; Z=bye; echo "$Z"')).out).toBe('hi\n');
  // single flags still work.
  expect((await run('declare -i n=3+4; echo "$n"')).out).toBe('7\n');
  expect((await run('declare -r y=1; y=2; echo "$y"')).out).toBe('1\n');
});

test('sparse indexed arrays skip holes in ${arr[@]}/${#arr[@]}/${!arr[@]}', async () => {
  expect((await run('arr[5]=x; echo "${arr[@]}"')).out).toBe('x\n');           // no `undefined` holes
  expect((await run('arr[5]=x; echo "${#arr[@]}"')).out).toBe('1\n');          // count present only
  expect((await run('arr[2]=a; arr[7]=b; echo "${!arr[@]}"')).out).toBe('2 7\n'); // present indices
  expect((await run('arr[1]=a; arr[4]=b; arr[9]=c; echo "${arr[@]}"')).out).toBe('a b c\n');
  // dense arrays unaffected
  expect((await run('a=(x y z); echo "${a[@]} ${#a[@]} ${!a[@]}"')).out).toBe('x y z 3 0 1 2\n');
});

test('a bare array name in arithmetic resolves to element 0 ($((a)) == $((a[0])))', async () => {
  expect((await run('a=(5 9); echo $((a))')).out).toBe('5\n');
  expect((await run('a=(5 9); echo $((a+1))')).out).toBe('6\n');
  expect((await run('a=(7 8); let "x = a * 2"; echo $x')).out).toBe('14\n');
  expect((await run('a=(2); for ((i=a; i<5; i++)); do printf "%s " $i; done')).out).toBe('2 3 4 ');
  // a real scalar still takes precedence; an empty array is 0
  expect((await run('a=100; echo $((a))')).out).toBe('100\n');
  expect((await run('a=(); echo $((a+5))')).out).toBe('5\n');
});

test('nested-bracket subscript in an array-element assignment (a[b[0]]=v)', async () => {
  expect((await run('a=(0 0 0); b=(2); a[b[0]]=Z; echo "${a[2]}"')).out).toBe('Z\n');
  expect((await run('a=(0 0 0); b=(3); a[b[0]-1]=Q; echo "${a[2]}"')).out).toBe('Q\n');
  // simple/arithmetic subscripts still parse
  expect((await run('a=(0 0 0); i=1; a[i+1]=W; echo "${a[2]}"')).out).toBe('W\n');
});

test('declare -i arithmetic-evaluates array-element assignments', async () => {
  expect((await run('declare -i a; a[0]=3+4; echo "${a[0]}"')).out).toBe('7\n');
  expect((await run('declare -i a; a[0]=10; a[0]+=5; echo "${a[0]}"')).out).toBe('15\n');
  expect((await run('declare -Ai m; m[k]=2*3; echo "${m[k]}"')).out).toBe('6\n');
  // non-integer array stores the literal
  expect((await run('a[0]=3+4; echo "${a[0]}"')).out).toBe('3+4\n');
});

test('value @-transforms (@Q @U @u @L @E) apply to array/assoc elements', async () => {
  expect((await run('a=(hello world); echo "${a[0]@U}"')).out).toBe('HELLO\n');
  expect((await run('a=(HELLO); echo "${a[0]@L}"')).out).toBe('hello\n');
  expect((await run('a=(hello); echo "${a[0]@u}"')).out).toBe('Hello\n');
  expect((await run('declare -A m; m[k]=hello; echo "${m[k]@U}"')).out).toBe('HELLO\n');
  // scalar transforms unaffected
  expect((await run('v=hi; echo "${v@U}"')).out).toBe('HI\n');
});

test('unset clears arrays/assoc/elements (not just scalars)', async () => {
  expect((await run('a=(x y z); unset a; echo "[${a[@]}] ${#a[@]}"')).out).toBe('[] 0\n');
  expect((await run('declare -A m; m[k]=v; unset m; echo "[${m[k]}]"')).out).toBe('[]\n');
  expect((await run('a=(x y z); unset "a[1]"; echo "${a[@]} ${#a[@]}"')).out).toBe('x z 2\n');
  expect((await run('declare -A m; m[a]=1; m[b]=2; unset "m[a]"; echo "${m[b]} ${#m[@]}"')).out).toBe('2 1\n');
  expect((await run('a=(x y z); unset "a[-1]"; echo "${a[@]}"')).out).toBe('x y\n');
  // scalar unset + readonly-block still work
  expect((await run('x=5; unset x; echo "[$x]"')).out).toBe('[]\n');
  expect((await run('readonly r=1; unset r; echo "$r"')).err).toMatch(/readonly/);
});

test('declare/local/readonly with += appends (integer adds, string concats)', async () => {
  expect((await run('declare -i s=10; declare -i s+=5; echo "$s"')).out).toBe('15\n');
  expect((await run('declare s=hello; declare s+=world; echo "$s"')).out).toBe('helloworld\n');
  expect((await run('f(){ local -i c=3; local -i c+=2; echo "$c"; }; f')).out).toBe('5\n');
  // a second `readonly NAME=…` on an already-readonly var is rejected (value kept)
  const r = await run('readonly RO=1; readonly RO=2; echo "$RO"');
  expect(r.out).toBe('1\n');
  expect(r.err).toMatch(/readonly/);
  // but the FIRST readonly declaration succeeds
  expect((await run('readonly RO=7; echo "$RO"')).out).toBe('7\n');
});

test('multi-name readonly assigns non-readonly names even when one is already readonly', async () => {
  const r = await run('readonly B=x; readonly A=aa B=bb C=cc; echo "$A|$C"');
  expect(r.out).toBe('aa|cc\n');       // A and C still assigned (B rejected)
  expect(r.err).toMatch(/readonly/);   // B reported
  expect((await run('readonly A=1 B=2 C=3; echo "$A$B$C"')).out).toBe('123\n');
});

// ── declare/local/readonly/export NAME=(…) array-literal (bash parity) ───────

test('declare -a / declare NAME=(…) builds an indexed array', async () => {
  expect((await run('declare -a arr=(a b c); echo "[${arr[@]}] n=${#arr[@]}"')).out).toBe('[a b c] n=3\n');
  // WITHOUT -a a `(...)` literal still makes an indexed array (bash).
  expect((await run('declare arr=(a b c); echo "[${arr[@]}]"')).out).toBe('[a b c]\n');
  // A quoted element with a space stays ONE element (the old word-split regression).
  expect((await run('declare -a arr=("a b" c); echo "0=[${arr[0]}] 1=[${arr[1]}] n=${#arr[@]}"')).out)
    .toBe('0=[a b] 1=[c] n=2\n');
});

test('readonly NAME=(…) creates AND marks the array readonly', async () => {
  const r = await run('readonly arr=(p q); arr[0]=X; echo "[${arr[@]}]"');
  expect(r.out).toBe('[p q]\n');           // element write rejected, value unchanged
  expect(r.err).toMatch(/readonly/);
});

test('declare -A NAME=([k]=v …) builds an associative array', async () => {
  expect((await run('declare -A m=([x]=1 [y]=2); echo "x=${m[x]} y=${m[y]} n=${#m[@]}"')).out)
    .toBe('x=1 y=2 n=2\n');
  // assoc value with a space via [k]="…".
  expect((await run('declare -A m=([x]="a b" [y]=c); echo "x=[${m[x]}] n=${#m[@]}"')).out)
    .toBe('x=[a b] n=2\n');
});

test('local NAME=(…) array is function-scoped (does not leak out)', async () => {
  const r = await run('arr=(GLOBAL); f() { local arr=(x y z); echo "in:[${arr[@]}]"; }; f; echo "out:[${arr[@]}]"');
  expect(r.out).toBe('in:[x y z]\nout:[GLOBAL]\n');
  // local -A assoc is scoped too.
  const a = await run('declare -A m=([g]=1); f(){ local -A m=([x]=9); echo "in:${m[x]}"; }; f; echo "out:${m[g]}:${m[x]-unset}"');
  expect(a.out).toBe('in:9\nout:1:unset\n');
});

test('declare -ai NAME=(…) arithmetic-evaluates array-literal elements', async () => {
  expect((await run('declare -ai b=(1+1 2*3); echo "[${b[@]}]"')).out).toBe('[2 6]\n');
});

test('declare NAME+=(…) appends to an existing array', async () => {
  expect((await run('declare -a arr=(a b); declare arr+=(c d); echo "[${arr[@]}] n=${#arr[@]}"')).out)
    .toBe('[a b c d] n=4\n');
});

test('export NAME=(…) creates the (non-exported) array', async () => {
  expect((await run('export arr=(a b c); echo "[${arr[@]}]"')).out).toBe('[a b c]\n');
});

test('explicit [index]=value elements in an array literal (sparse + running index)', async () => {
  expect((await run('declare -a arr=([2]=x [5]=y); echo "2=[${arr[2]}] 5=[${arr[5]}] n=${#arr[@]}"')).out)
    .toBe('2=[x] 5=[y] n=2\n');
  // A bare word after an explicit index continues from index+1 (bash).
  expect((await run('arr=(a [5]=z w); echo "0=${arr[0]} 5=${arr[5]} 6=${arr[6]} n=${#arr[@]}"')).out)
    .toBe('0=a 5=z 6=w n=3\n');
});

test('scalar declare/export are unchanged by the array-literal routing', async () => {
  expect((await run('declare x=5; echo "$x"')).out).toBe('5\n');
  expect((await run('export PATH=/bin; echo "$PATH"')).out).toBe('/bin\n');
  expect((await run('declare -r x=1 arr=(a b); x=2; echo "x=$x [${arr[@]}]"')).err).toMatch(/readonly/);
});

test('declare NAME=(…) array literal is rejected in POSIX mode (parse-time)', () => {
  // The assignment-builtin reroute reuses parseAssignmentWord, which rejects an
  // array literal under posix — same as a bare `arr=(…)`.
  expect(() => parse('declare -a arr=(a b c)', { posix: true })).toThrow(/POSIX/i);
  expect(() => parse('arr=(a b c)', { posix: true })).toThrow(/POSIX/i);
  // non-posix parse is fine.
  expect(() => parse('declare -a arr=(a b c)')).not.toThrow();
});
