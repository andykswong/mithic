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

test('(( )) and arith-for handle shift-assign <<= />>= (lexer splits << from =)', async () => {
  expect((await run('x=1; (( x <<= 3 )); echo $x')).out).toBe('8\n');
  expect((await run('x=8; (( x >>= 1 )); echo $x')).out).toBe('4\n');
  expect((await run('for ((i=1;i<8;i<<=1)); do echo $i; done')).out).toBe('1\n2\n4\n');
  // other compound-assign + comparisons in (( )) still parse.
  expect((await run('x=1; (( x += 2 )); echo $x')).out).toBe('3\n');
  expect((await run('(( a = 3 < 5 )); echo $a')).out).toBe('1\n');
});

test('arithmetic short-circuit in $(( )) does not leak errors/side-effects', async () => {
  expect((await run('echo before; echo $((0 && 1/0)); echo after')).out).toBe('before\n0\nafter\n');
  expect((await run('x=0; echo $((1 ? 10 : (x=99))); echo $x')).out).toBe('10\n0\n');
  // a subscript side effect in a dead branch does not run (inherits suppression).
  expect((await run('a=(5 6 7); i=0; echo $(( 0 ? a[i++] : 9 )); echo "i=$i"')).out).toBe('9\ni=0\n');
  expect((await run('i=1; echo $(( 0 && a[i++] )); echo "i=$i"')).out).toBe('0\ni=1\n');
});

test('an integer-attributed assignment with a malformed arith RHS errors (exit 1), var unchanged', async () => {
  const r = await run('declare -i n; n=3+; echo "n=$n rc=$?"');
  expect(r.out).toBe('n= rc=1\n');   // n left unset, status 1
  expect(r.err).not.toBe('');         // a diagnostic is emitted
});

test('a (( )) command arith error is non-fatal (status 1), the script continues', async () => {
  expect((await run('echo before; (( 5/0 )); echo "after=$?"')).out).toBe('before\nafter=1\n');
  expect((await run('(( 08 )); echo "rc=$?"; echo tail')).out).toBe('rc=1\ntail\n');
  // a genuine $(( )) word-context error still aborts (bash) — unchanged.
});

test('associative arrays work in arithmetic context ((( )), $(( )), let)', async () => {
  expect((await run('declare -A c; c[k]=10; echo $((c[k]+5))')).out).toBe('15\n');
  expect((await run('declare -A c; for w in a a b; do (( c[$w]++ )); done; echo "a=${c[a]} b=${c[b]}"')).out)
    .toBe('a=2 b=1\n');
  expect((await run('declare -A m; (( m[x] = 3 * 4 )); echo "${m[x]}"')).out).toBe('12\n');
});

test('per-element string ops apply to ${arr[@]} / ${arr[*]}', async () => {
  expect((await run('arr=(hello world); echo "${arr[@]^^}"')).out).toBe('HELLO WORLD\n');
  expect((await run('arr=(a.txt b.txt); echo "${arr[@]%.txt}"')).out).toBe('a b\n');
  expect((await run('arr=(hello world); echo "${arr[@]/o/0}"')).out).toBe('hell0 w0rld\n');
  expect((await run('arr=(pre_a pre_b); echo "${arr[@]#pre_}"')).out).toBe('a b\n');
});

test('quoted "${!arr[@]}" splits into separate index words', async () => {
  expect((await run('a=(x y z); n=0; for i in "${!a[@]}"; do n=$((n+1)); done; echo "$n"')).out).toBe('3\n');
  expect((await run('a=(10 20 30); t=0; for i in "${!a[@]}"; do t=$((t+a[i])); done; echo "$t"')).out).toBe('60\n');
});

test('printf -v VAR assigns the formatted output to a variable', async () => {
  expect((await run('printf -v x "%d" 42; echo "[$x]"')).out).toBe('[42]\n');
  expect((await run('printf -v msg "%s-%s" a b; echo "$msg"')).out).toBe('a-b\n');
  expect((await run('printf -vx "%d" 9; echo "$x"')).out).toBe('9\n');       // attached -vNAME
  // without -v it still writes to stdout.
  expect((await run('printf "%d\\n" 7')).out).toBe('7\n');
});

test('declare -p prints a nameref; [[ -v NAME ]] tests set-ness', async () => {
  expect((await run('declare -n ref=v; v=hi; declare -p ref')).out).toBe('declare -n ref="v"\n');
  expect((await run('foo=1; [[ -v foo ]] && echo set || echo unset')).out).toBe('set\n');
  expect((await run('[[ -v bar ]] && echo set || echo unset')).out).toBe('unset\n');
  expect((await run('a=(x y); [[ -v a[1] ]] && echo set || echo unset')).out).toBe('set\n');
  expect((await run('a=(x); [[ -v a[5] ]] && echo set || echo unset')).out).toBe('unset\n');
});

test('declare NAME[i]=value is an element write; local on a readonly var is rejected', async () => {
  expect((await run('a=(1 2 3); declare a[1]=X; echo "${a[@]}"')).out).toBe('1 X 3\n');
  expect((await run('declare -A m=([x]=1); declare m[y]=2; echo "${m[x]}${m[y]}"')).out).toBe('12\n');
  const r = await run('readonly R=c; f(){ local R=x; echo "in=$R"; }; f; echo "out=$R"');
  expect(r.out).toBe('in=c\nout=c\n'); expect(r.err).toMatch(/readonly/);
});

test('[[ N -eq M ]] with an invalid arith operand errors (false + diagnostic)', async () => {
  const r = await run('[[ 08 -eq 0 ]]; echo "rc=$?"');
  expect(r.out).toBe('rc=1\n'); expect(r.err).toMatch(/value too great for base/);
});

test('${var~} / ${var~~} toggle case; numeric brace ranges zero-pad', async () => {
  expect((await run('a=hello; echo "${a~}"')).out).toBe('Hello\n');
  expect((await run('a=hello; echo "${a~~}"')).out).toBe('HELLO\n');
  expect((await run('a=HELLO; echo "${a~~}"')).out).toBe('hello\n');
  expect((await run('echo {01..05}')).out).toBe('01 02 03 04 05\n');
  expect((await run('echo {001..3}')).out).toBe('001 002 003\n');
  expect((await run('echo {-01..01}')).out).toBe('-01 000 001\n');
  expect((await run('echo {1..5}')).out).toBe('1 2 3 4 5\n'); // no padding without leading zero
});

test('export attribute is tracked (declare -p shows -x); %G trims trailing zeros', async () => {
  expect((await run('export FOO=bar; declare -p FOO')).out).toBe('declare -x FOO="bar"\n');
  expect((await run('declare -rx e=hi; declare -p e')).out).toBe('declare -rx e="hi"\n');
  expect((await run('export x=1; echo "${x@a}"')).out).toBe('x\n');
  // %G (uppercase) trims trailing zeros in the exponent branch (was only lowercase %g).
  expect((await run('printf "%G\\n" 1000000')).out).toBe('1E+06\n');
  expect((await run('printf "%G\\n" 0.00001')).out).toBe('1E-05\n');
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

test('${ref@A} FOLLOWS the nameref and reconstructs the TARGET variable (bash 5) — real Environment', async () => {
  // bash 5.3: `${ref@A}` where ref→target reconstructs the TARGET (`target='hi'`),
  // NOT `declare -n ref=target` (which is what `declare -p ref` shows).
  const { out } = await run('target=hi; declare -n ref=target; echo "${ref@A}"');
  expect(out.trim()).toBe('target=\'hi\'');
});

test('${x@A} on a plain scalar reconstructs `name=\'value\'` (bash-5 @Q form) — real Environment', async () => {
  const { out } = await run('x="a b"; echo "${x@A}"');
  expect(out.trim()).toBe('x=\'a b\'');
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

// ── declare -l / -u case-fold attribute (fold every assigned value) ──────────

test('declare -l lowercases and -u uppercases on assignment', async () => {
  expect((await run('declare -l x=HELLO; echo $x')).out).toBe('hello\n');
  expect((await run('declare -u y=hello; echo $y')).out).toBe('HELLO\n');
  expect((await run('typeset -l q=BIG; echo $q')).out).toBe('big\n');
});

test('declare -l/-u folds on LATER writes too (attribute is sticky)', async () => {
  expect((await run('declare -l x=HELLO; x=WORLD; echo $x')).out).toBe('world\n');
  expect((await run('declare -l x; x=MiXeD; echo $x')).out).toBe('mixed\n');
  expect((await run('declare -u v=ab; v+=CD; echo $v')).out).toBe('ABCD\n');
  expect((await run('declare -l w=AB; w+=cd; echo $w')).out).toBe('abcd\n');
});

test('declare -l/-u fold array literals and element writes', async () => {
  expect((await run('declare -la arr=(FOO Bar); echo ${arr[0]} ${arr[1]}')).out).toBe('foo bar\n');
  expect((await run('declare -la arr; arr[0]=HeLLo; echo ${arr[0]}')).out).toBe('hello\n');
  expect((await run('declare -uA m=([k]=abc); echo ${m[k]}')).out).toBe('ABC\n');
});

test('declare -lu (both) cancels to NO case-fold attribute', async () => {
  expect((await run('declare -lu z=Hi; echo $z')).out).toBe('Hi\n');
  expect((await run('declare -ul z=Hi; echo $z')).out).toBe('Hi\n');
});

test('applying -l to an EXISTING value does not refold it; only later writes fold', async () => {
  expect((await run('x=HELLO; declare -l x; echo $x')).out).toBe('HELLO\n');
  expect((await run('x=HELLO; declare -l x; x=AGAIN; echo $x')).out).toBe('again\n');
});

test('+l / +u removes the case-fold attribute (matching direction only)', async () => {
  expect((await run('declare -l x=abc; declare +l x; x=DEF; echo $x')).out).toBe('DEF\n');
  // +u on a -l var keeps the LOWER fold; +l on a -u var keeps UPPER (bash).
  expect((await run('declare -l x=Hi; declare +u x; x=AB; echo $x')).out).toBe('ab\n');
  expect((await run('declare -u x=hi; declare +l x; x=ab; echo $x')).out).toBe('AB\n');
  // -u after -l switches direction.
  expect((await run('declare -l x=Hi; declare -u x; x=ab; echo $x')).out).toBe('AB\n');
});

test('declare -p reflects the -l/-u attribute (and bare -l name with no value)', async () => {
  expect((await run('declare -l x=Hi; declare -p x')).out).toBe('declare -l x="hi"\n');
  expect((await run('declare -u y=hi; declare -p y')).out).toBe('declare -u y="HI"\n');
  expect((await run('declare -l n; declare -p n')).out).toBe('declare -l n\n');
  // flag order: a/i/r/x then l/u last (bash)
  expect((await run('declare -rxl m=Hi; declare -p m')).out).toBe('declare -rxl m="hi"\n');
});

test('declare -i overrides -l for scalar (arithmetic value, digits unaffected)', async () => {
  expect((await run('declare -i -l x=5+3; echo $x')).out).toBe('8\n');
});

test('a function-local declare -l does not leak its fold attribute to the caller', async () => {
  const src = 'x=OUTER; f() { local -l x; x=INNER; echo "$x"; }; f; echo "$x"; x=AGAIN; echo "$x"';
  expect((await run(src)).out).toBe('inner\nOUTER\nAGAIN\n');
});

test('a function-local -l/-u fold does NOT apply to a same-name declare -g global write', async () => {
  // bash: the -g write targets the global binding, which has no fold from the local.
  expect((await run('f(){ declare -u g; declare -g g=hello; }; f; echo "[$g]"')).out).toBe('[hello]\n');
  expect((await run('h(){ declare -l g2; declare -g g2=HELLO; }; h; echo "[$g2]"')).out).toBe('[HELLO]\n');
  expect((await run('k(){ declare -u g3=inner; declare -g g3=hello; }; k; echo "[$g3]"')).out).toBe('[hello]\n');
  // but a GLOBAL that itself has -u DOES fold a -g write from inside a function
  expect((await run('declare -u G=x; m(){ declare -g G=hello; }; m; echo "[$G]"')).out).toBe('[HELLO]\n');
});

test('declare -gu/-gl (fold flag ON the -g command) folds + records on the global binding', async () => {
  // The fold flag is on the SAME -g command → fold the value AND persist the attr on
  // the global (bash), even with a same-name local shadow.
  expect((await run('f(){ declare g=lv; declare -gu g=hello; }; f; echo "[$g]"')).out).toBe('[HELLO]\n');
  expect((await run('h(){ declare g=lv; declare -gl g=HELLO; }; h; echo "[$g]"')).out).toBe('[hello]\n');
  expect((await run('f(){ declare g=lv; declare -gu g=hello; }; f; declare -p g')).out).toBe('declare -u g="HELLO"\n');
  // a later GLOBAL-scope write then folds by the now-global attribute
  expect((await run('f(){ declare g=lv; declare -gu g=hi; }; f; g=more; echo "[$g]"')).out).toBe('[MORE]\n');
});

test('readonly/export reject declare-only options loudly (exit 2), not silently', async () => {
  // readonly accepts only -aAfp; a declare-only letter is an invalid option (bash).
  const ro = await run('readonly -l x; echo "rc=$?"');
  expect(ro.out).toBe('rc=2\n');
  expect(ro.err).toMatch(/readonly: -l: invalid option/);
  expect((await run('readonly -u x; echo "rc=$?"')).out).toBe('rc=2\n');
  expect((await run('readonly -i x; echo "rc=$?"')).out).toBe('rc=2\n');
  // valid readonly options still accepted
  expect((await run('readonly -a arr; echo "rc=$?"')).out).toBe('rc=0\n');
  // export accepts only -fnp; -i is invalid
  const ex = await run('export -i x; echo "rc=$?"');
  expect(ex.out).toBe('rc=2\n');
  expect(ex.err).toMatch(/export: -i: invalid option/);
  expect((await run('export -n x; echo "rc=$?"')).out).toBe('rc=0\n');
  // the correct combined forms are unaffected
  expect((await run('declare -rl x=Hi; echo "$x"')).out).toBe('hi\n');
});

test('declare -g NAME[i]=v element write folds by the VISIBLE (local) attribute, not the global', async () => {
  // An element write lands in the visible local binding, so it folds by the local's
  // attribute (bash). The global's -l/-u must NOT apply to it.
  expect((await run('declare -gu a; f(){ local a=zz; declare -g a[1]=hello; echo "${a[1]}"; }; f')).out).toBe('hello\n');
  expect((await run('f(){ local -u a; declare -g a[1]=hello; echo "${a[1]}"; }; f')).out).toBe('HELLO\n');
  expect((await run('f(){ local -a a; declare -gl a[0]=WORLD; echo "${a[0]}"; }; f')).out).toBe('WORLD\n');
  // top-level (no shadow): the global attribute DOES apply to its own element write
  expect((await run('declare -gu a; declare -g a[1]=hello; echo "${a[1]}"')).out).toBe('HELLO\n');
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

test('numeric comparisons are 64-bit; [ ] is decimal, [[ ]] is arithmetic', async () => {
  // 64-bit precision beyond 2^53 (was Number()-truncated).
  expect((await run('[ 9223372036854775807 -eq 9223372036854775806 ] && echo EQ || echo NE')).out).toBe('NE\n');
  expect((await run('[[ 9223372036854775807 -eq 9223372036854775807 ]] && echo BIG')).out).toBe('BIG\n');
  // `[ ]`/test operands are DECIMAL (010 == ten, not octal eight).
  expect((await run('[ 010 -eq 10 ] && echo DEC || echo N')).out).toBe('DEC\n');
  // `[[ ]]` operands are ARITHMETIC (010 == octal 8, 0x10 == 16, bare var).
  expect((await run('[[ 010 -eq 8 ]] && echo OCT')).out).toBe('OCT\n');
  expect((await run('[[ 0x10 -eq 16 ]] && echo HEX')).out).toBe('HEX\n');
  expect((await run('x=100; [[ x -eq 100 ]] && echo VAR')).out).toBe('VAR\n');
});

test('[ ] numeric comparison errors (exit 2) on a non-integer or out-of-int64-range operand', async () => {
  const big = await run('[ 10000000000000000000 -gt 5 ]; echo "rc=$?"');
  expect(big.out).toBe('rc=2\n'); expect(big.err).toMatch(/integer expected/);
  const over = await run('[ 9223372036854775808 -gt 5 ]; echo "rc=$?"'); // INT64_MAX + 1
  expect(over.out).toBe('rc=2\n');
  const nan = await run('[ abc -gt 5 ]; echo "rc=$?"');
  expect(nan.out).toBe('rc=2\n'); expect(nan.err).toMatch(/integer expected/);
  // INT64_MAX itself is valid.
  expect((await run('[ 9223372036854775807 -gt 5 ] && echo OK')).out).toBe('OK\n');
});

// ── test/[ ] real file tests (were silently string-tests → always true) ──────
// The plain `[`/`test` builtin previously had NO file-test support: `-f`/`-d`/`-e`
// fell through to a 1-arg string test, so `[ -f /nonexistent ]` wrongly returned
// true. These now stat the VFS exactly like `[[ -f ]]` does.

test('test/[ ] -f/-d/-e are REAL file tests over the VFS (not string tests)', async () => {
  const fs = mockFs({ '/exists.txt': 'hi', '/dir/inner': 'x' });
  expect((await run('[ -f /exists.txt ]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[ -f /missing.txt ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -e /exists.txt ]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[ -e /missing ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -d /dir ]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[ -d /exists.txt ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -f /dir ]; echo $?', {}, fs)).out).toBe('1\n');
});

test('test/[ ] -f negation and -a/-o combine with file tests', async () => {
  const fs = mockFs({ '/exists.txt': 'hi' });
  expect((await run('[ ! -f /missing ]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[ -f /exists.txt -a -f /missing ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -f /exists.txt -o -f /missing ]; echo $?', {}, fs)).out).toBe('0\n');
});

test('test/[ ] -v NAME tests variable set-ness (like [[ -v ]])', async () => {
  expect((await run('foo=1; [ -v foo ]; echo $?')).out).toBe('0\n');
  expect((await run('[ -v bar ]; echo $?')).out).toBe('1\n');
});

test('test/[ ] metadata file tests use real size/mode/mtime (fall FALSE when unknowable)', async () => {
  // A rich FsClient carrying size/mode/type/mtimeMs (as the real VFS does).
  const meta: Record<string, any> = {
    '/x': { dir: false, type: 'file', size: 5, mode: 0o755, mtimeMs: 2000 },
    '/plain': { dir: false, type: 'file', size: 5, mode: 0o644, mtimeMs: 1000 },
    '/empty': { dir: false, type: 'file', size: 0, mode: 0o644, mtimeMs: 1000 },
    '/noperm': { dir: false, type: 'file', size: 5, mode: 0o000, mtimeMs: 1000 },
    '/d': { dir: true, type: 'directory', size: 0, mode: 0o755, mtimeMs: 1000 },
  };
  const richFs = { fsStat: async (p: string) => meta[p] };
  const t = async (src: string) => (await run(src + '; echo $?', {}, richFs)).out;
  // -s non-empty (size), and a dir is always non-empty
  expect(await t('[ -s /plain ]')).toBe('0\n');
  expect(await t('[ -s /empty ]')).toBe('1\n');
  expect(await t('[ -s /d ]')).toBe('0\n');
  // -x honors the exec bit; a dir is searchable (true)
  expect(await t('[ -x /x ]')).toBe('0\n');
  expect(await t('[ -x /plain ]')).toBe('1\n');
  expect(await t('[ -x /d ]')).toBe('0\n');
  // -r/-w honor the read/write bits
  expect(await t('[ -r /plain ]')).toBe('0\n');
  expect(await t('[ -w /noperm ]')).toBe('1\n');
  // -nt/-ot compare mtime; a missing operand is "older than any existing file"
  expect(await t('[ /plain -nt /x ]')).toBe('1\n');
  expect(await t('[ /x -nt /plain ]')).toBe('0\n');
  expect(await t('[ /x -nt /nope ]')).toBe('0\n');
  expect(await t('[ /nope -nt /x ]')).toBe('1\n');
});

test('test/[ ] metadata tests fall FALSE (never silently true) when a mock omits the metadata', async () => {
  // A {dir}-only FsClient (no size/mode) — mode-based tests must NOT return a
  // plausible-but-wrong true; they fall to false (fail-safe, never silently wrong).
  const fs = mockFs({ '/exists.txt': 'hi' });
  expect((await run('[ -x /exists.txt ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -r /exists.txt ]; echo $?', {}, fs)).out).toBe('1\n');
  // but existence-only tests still work
  expect((await run('[ -e /exists.txt ]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[ -f /exists.txt ]; echo $?', {}, fs)).out).toBe('0\n');
});

test('test/[ ] an EMPTY path operand is nonexistent (not resolved to cwd)', async () => {
  const fs = mockFs({ '/exists.txt': 'hi' });
  expect((await run('[ -e "" ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -f "" ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ -d "" ]; echo $?', {}, fs)).out).toBe('1\n');
  expect((await run('[ "" -ef "" ]; echo $?', {}, fs)).out).toBe('1\n');
});

// ── test/[ ] bash diagnostics: unary/binary operator expected, arg counts ────

test('test/[ ] with a missing binary operand → "unary operator expected", exit 2', async () => {
  const r = await run('[ 5 -gt ]; echo "rc=$?"');
  expect(r.out).toBe('rc=2\n');
  expect(r.err).toMatch(/5: unary operator expected/);
});

test('test/[ ] with an unknown unary operator → "unary operator expected", exit 2', async () => {
  const r = await run('[ -q x ]; echo "rc=$?"');
  expect(r.out).toBe('rc=2\n');
  expect(r.err).toMatch(/-q: unary operator expected/);
  const two = await run('[ abc def ]; echo "rc=$?"');
  expect(two.out).toBe('rc=2\n');
  expect(two.err).toMatch(/abc: unary operator expected/);
});

test('test/[ ] with an unknown binary operator → "binary operator expected", exit 2', async () => {
  const r = await run('[ a -zz b ]; echo "rc=$?"');
  expect(r.out).toBe('rc=2\n');
  expect(r.err).toMatch(/-zz: binary operator expected/);
  const three = await run('[ a b c ]; echo "rc=$?"');
  expect(three.out).toBe('rc=2\n');
  expect(three.err).toMatch(/b: binary operator expected/);
});

test('test/[ ] with too many arguments → "too many arguments", exit 2', async () => {
  const r = await run('[ a b c d ]; echo "rc=$?"');
  expect(r.out).toBe('rc=2\n');
  expect(r.err).toMatch(/too many arguments/);
  const t = await run('test 5 -gt 3 x; echo "rc=$?"');
  expect(t.out).toBe('rc=2\n');
  expect(t.err).toMatch(/test: too many arguments/);
});

test('test/[ ] 3-arg -a/-o are BINARY and/or (not the file/option unary forms)', async () => {
  expect((await run('[ a -a b ]; echo $?')).out).toBe('0\n');
  expect((await run('[ "" -a b ]; echo $?')).out).toBe('1\n');
  expect((await run('[ a -o "" ]; echo $?')).out).toBe('0\n');
  expect((await run('[ "" -o "" ]; echo $?')).out).toBe('1\n');
});

test('test/[ ] valid comparisons and short forms still pass (no false diagnostics)', async () => {
  expect((await run('[ 5 -gt 3 ]; echo $?')).out).toBe('0\n');
  expect((await run('[ a = a ]; echo $?')).out).toBe('0\n');
  expect((await run('[ -z "" ]; echo $?')).out).toBe('0\n');
  expect((await run('[ x ]; echo $?')).out).toBe('0\n');
  expect((await run('[ "" ]; echo $?')).out).toBe('1\n');
  expect((await run('[ ]; echo $?')).out).toBe('1\n');
  expect((await run('[ -f ]; echo $?')).out).toBe('0\n'); // 1-arg: "-f" is non-empty
  expect((await run('[ = ]; echo $?')).out).toBe('0\n');
  expect((await run('[ ! x ]; echo $?')).out).toBe('1\n');
  expect((await run('[ \\( a \\) ]; echo $?')).out).toBe('0\n');
});

test('[[ ]] parenthesized grouping', async () => {
  const fs = mockFs({ '/exists.txt': 'hi', '/dir/x': 'y' });
  expect((await run('[[ ( -f /exists.txt ) ]]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[[ ( -f /exists.txt ) && ( -d /dir ) ]]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[[ ( -f /nope || -d /dir ) ]]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[[ ( -f /nope ) || ( -f /nope2 ) ]]; echo $?', {}, fs)).out).toBe('1\n');
  // grouping overrides the flat left-to-right of && / ||
  expect((await run('[[ -n a || -n b && -z c ]]; echo $?')).out).toBe('0\n');
  expect((await run('[[ ( -n a || -n b ) && -z c ]]; echo $?')).out).toBe('1\n');
});

test('[[ ]] QUOTED ( / ) operands are strings, not grouping (no miscount around && / ||)', async () => {
  // A quoted '(' operand must NOT affect the top-level && / || split.
  expect((await run('[[ \'(\' == \'(\' && a == a ]] && echo T || echo F')).out).toBe('T\n');
  expect((await run('[[ \')\' == \')\' || x == y ]] && echo T || echo F')).out).toBe('T\n');
  expect((await run('[[ \'(\' == \')\' ]] && echo T || echo F')).out).toBe('F\n');
  // real grouping still works alongside a quoted-paren operand
  expect((await run('[[ ( \'(\' == \'(\' ) && a == a ]] && echo T || echo F')).out).toBe('T\n');
});

test('[[ ]] =~ regex inside a ( ) grouping (coalescer stops at the enclosing close paren)', async () => {
  expect((await run('[[ ( abc =~ (a) ) ]] && echo T || echo F')).out).toBe('T\n');
  expect((await run('[[ ( abc =~ (a) ) && ( def =~ d ) ]] && echo T || echo F')).out).toBe('T\n');
  expect((await run('[[ ( abc =~ ^a ) || ( xyz =~ ^q ) ]] && echo T || echo F')).out).toBe('T\n');
  expect((await run('[[ ( abc =~ (a)(b)(c) ) && x == x ]] && echo T || echo F')).out).toBe('T\n');
  // regexes with their own balanced parens still survive OUTSIDE a group
  expect((await run('[[ ab12 =~ ([a-z]+)([0-9]+) ]] && echo T || echo F')).out).toBe('T\n');
});

test('[[ ]] -ef/-nt/-ot binary file-comparison operators', async () => {
  const fs = mockFs({ '/a.txt': 'x', '/b.txt': 'y' });
  expect((await run('[[ /a.txt -ef /a.txt ]]; echo $?', {}, fs)).out).toBe('0\n');
  expect((await run('[[ /a.txt -ef /b.txt ]]; echo $?', {}, fs)).out).toBe('1\n');
  // -nt/-ot need mtime the VFS lacks → conservatively false, matching [ ]
  expect((await run('[[ /a.txt -nt /b.txt ]]; echo $?', {}, fs)).out).toBe('1\n');
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

test('type -P forces a $PATH search even when a builtin shadows the name', async () => {
  // `echo` is a builtin AND at /bin/echo; -p yields nothing (shadowed), -P forces it.
  expect((await run('type -p echo', PATHENV, pathFs())).out).toBe('');       // shadowed → empty
  expect((await run('type -P echo', PATHENV, pathFs())).out).toBe('/bin/echo\n');
  expect((await run('type -p ls', PATHENV, pathFs())).out).toBe('/bin/ls\n');  // ls not a builtin
});

test('type -P of a shadowed name with no $PATH file exits 1 (force-search miss)', async () => {
  // `if` (keyword) and a function have no PATH file: -P forces a search → miss, rc 1.
  expect((await run('type -P if; echo "rc=$?"', PATHENV, pathFs())).out).toBe('rc=1\n');
  expect((await run('f(){ :; }; type -P f; echo "rc=$?"', PATHENV, pathFs())).out).toBe('rc=1\n');
  // -p of a shadowed builtin (echo) is silent with rc 0 (no forced search).
  expect((await run('type -p echo; echo "rc=$?"', PATHENV, pathFs())).out).toBe('rc=0\n');
});

test('type / command accept clustered flags and -- terminator', async () => {
  expect((await run('type -ta echo', PATHENV, pathFs())).out).toBe('builtin\nfile\n');
  expect((await run('type -- ls', PATHENV, pathFs())).out).toBe('ls is /bin/ls\n');
  expect((await run('command -vp ls', PATHENV, pathFs())).out).toBe('/bin/ls\n');
  expect((await run('command -Vp ls', PATHENV, pathFs())).out).toBe('ls is /bin/ls\n');
  expect((await run('command -- ls', PATHENV, pathFs())).out).toBe('');       // no /bin/ls to spawn in mock; just must not error on --
});

test('type -p / -P of an unknown name is silent (rc 1)', async () => {
  const p = await run('type -p nonexistent; echo "rc=$?"', PATHENV, pathFs());
  expect(p.out).toBe('rc=1\n'); expect(p.err).toBe('');
  const bigp = await run('type -P nonexistent; echo "rc=$?"', PATHENV, pathFs());
  expect(bigp.out).toBe('rc=1\n'); expect(bigp.err).toBe('');
});

test('type/command fall back to a default PATH when PATH is entirely unset', async () => {
  // No PATH var at all → bash uses a compiled-in default (/usr/bin:/bin here).
  expect((await run('type ls', {}, pathFs())).out).toBe('ls is /bin/ls\n');
  expect((await run('command -v ls', {}, pathFs())).out).toBe('/bin/ls\n');
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

test('name-keyed @a on an array/assoc element reports the container attributes', async () => {
  expect((await run('a=(one two three); echo "[${a[0]@a}]"')).out).toBe('[a]\n');
  expect((await run('declare -A m=([x]=1 [y]=2); echo "[${m[x]@a}]"')).out).toBe('[A]\n');
  expect((await run('declare -ai b=(5 6); echo "[${b[0]@a}]"')).out).toBe('[ai]\n');
  expect((await run('declare -ar c=(5 6); echo "[${c[0]@a}]"')).out).toBe('[ar]\n');
  // an UNSET assoc key still reports the container attribute (bash).
  expect((await run('declare -A m=([k]=v); echo "[${m[nope]@a}]"')).out).toBe('[A]\n');
});

test('name-keyed @A on an element reconstructs a declare with the element value', async () => {
  // bash-5: `declare -FLAGS name='<@Q-quoted element value>'` (single element form).
  expect((await run('a2=(x "b c"); echo "${a2[1]@A}"')).out).toBe('declare -a a2=\'b c\'\n');
  expect((await run('declare -A m=([x]=1); echo "${m[x]@A}"')).out).toBe('declare -A m=\'1\'\n');
  expect((await run('declare -ai b=(7 8); echo "${b[0]@A}"')).out).toBe('declare -ai b=\'7\'\n');
});

test('name-keyed @K/@k on a single element quote the value (== @Q, no key)', async () => {
  expect((await run('declare -A m=([x]="1 2"); echo "${m[x]@K}"')).out).toBe('\'1 2\'\n');
  expect((await run('declare -A m=([x]="1 2"); echo "${m[x]@k}"')).out).toBe('\'1 2\'\n');
  expect((await run('a=(zero one); echo "${a[1]@K}"')).out).toBe('\'one\'\n');
  expect((await run('a=(zero one); echo "${a[1]@k}"')).out).toBe('\'one\'\n');
});

test('name-keyed @P on an element prompt-expands the element value', async () => {
  const r = await run('a=("\\\\u@\\\\h"); echo "${a[0]@P}"', { env: { USER: 'ada', HOSTNAME: 'box' } });
  expect(r.out).toBe('ada@box\n');
});

test('@Q of an unset element/key/scalar is empty (not \'\')', async () => {
  expect((await run('arr=(a b); echo "[${arr[9]@Q}]"')).out).toBe('[]\n');
  expect((await run('declare -A A=([x]=1); echo "[${A[zzz]@Q}]"')).out).toBe('[]\n');
  expect((await run('unset y; echo "[${y@Q}]"')).out).toBe('[]\n');
  // a SET-but-empty element still quotes to ''.
  expect((await run('arr=("" b); echo "[${arr[0]@Q}]"')).out).toBe('[\'\']\n');
});

test('a BARE array-name transform operates on element [0] (bash: $a == ${a[0]})', async () => {
  expect((await run('a=(1 2 3); echo "${a@A}"')).out).toBe('declare -a a=\'1\'\n');
  expect((await run('a=(x y z); echo "${a@Q}"')).out).toBe('\'x\'\n');
  expect((await run('a=(x y z); echo "${a@K}"')).out).toBe('\'x\'\n');
  expect((await run('a=(hello world); echo "${a#he}"')).out).toBe('llo\n'); // string op on elem 0
  expect((await run('a=([5]=z); echo "[${a:-def}]"')).out).toBe('[def]\n'); // elem 0 unset
  expect((await run('a=([5]=z); echo "${a@A}"')).out).toBe('declare -a a\n'); // unset elem 0 → no value
});

test('${arr[@]@A}/@K/@k and @Q/@U per-element transforms over the whole array', async () => {
  expect((await run('a=(1 2 3); echo "${a[@]@A}"')).out).toBe('declare -a a=([0]="1" [1]="2" [2]="3")\n');
  expect((await run('a=(x "y z"); echo "${a[@]@Q}"')).out).toBe('\'x\' \'y z\'\n');
  expect((await run('a=(hi bye); echo "${a[@]@U}"')).out).toBe('HI BYE\n');
  expect((await run('a=(a "b c"); echo "${a[@]@K}"')).out).toBe('0 "a" 1 "b c"\n');
  // assoc @K has a TRAILING space after the last pair (bash); indexed does not.
  expect((await run('declare -A m=([k1]=v1 [k2]=v2); echo "${m[@]@K}"')).out).toBe('k1 "v1" k2 "v2" \n');
});

test('a subscript on a SCALAR treats it as a 1-element array (bash)', async () => {
  expect((await run('s=hello; echo "${s[0]@Q}"')).out).toBe('\'hello\'\n');
  expect((await run('s=hello; echo "[${s[1]@Q}]"')).out).toBe('[]\n');
  expect((await run('s=hello; echo "${s[0]#he}"')).out).toBe('llo\n');
  expect((await run('s=hello; echo "${#s[0]}"')).out).toBe('5\n');
  expect((await run('s=hello; echo "${#s[1]}"')).out).toBe('0\n');
  expect((await run('s=hello; echo "${s[0]^^}"')).out).toBe('HELLO\n');
  expect((await run('s=hello; echo "${s[0]}"')).out).toBe('hello\n');
  // ${s[0]@A} of an attribute-less scalar is the bare `s='value'` form (not declare --).
  expect((await run('s=hello; echo "${s[0]@A}"')).out).toBe('s=\'hello\'\n');
  // a negative / non-zero subscript on a scalar is empty (bash "bad array subscript").
  expect((await run('s=hello; echo "[${s[-1]}]"')).out).toBe('[]\n');
});

test('${s[@]OP} / ${s[*]OP} transforms treat a scalar as a one-element array', async () => {
  expect((await run('s=hello; echo "${s[@]@U}"')).out).toBe('HELLO\n');
  expect((await run('s=hello; echo "${s[*]@U}"')).out).toBe('HELLO\n');
  expect((await run('s=hello; echo "${s[@]@Q}"')).out).toBe('\'hello\'\n');
  expect((await run('s=hello; echo "[${s[@]@a}]"')).out).toBe('[]\n');       // plain scalar: no attrs
  expect((await run('declare -i n=42; echo "[${n[@]@a}]"')).out).toBe('[i]\n'); // integer attr
});

test('${ref@A} follows a nameref; declare -p reconstructs assoc with bare-safe keys + trailing space', async () => {
  expect((await run('target=hi; declare -n ref=target; echo "${ref@A}"')).out).toBe('target=\'hi\'\n');
  expect((await run('declare -A m=([one]=1 [two]=2); declare -p m')).out).toBe('declare -A m=([one]="1" [two]="2" )\n');
  expect((await run('declare -A m=(["a b"]=1 [ok]=2); declare -p m')).out).toBe('declare -A m=(["a b"]="1" [ok]="2" )\n');
});

test('sparse array @A skips holes; array/element values use $\'…\' for control chars', async () => {
  expect((await run('declare -a a=([2]=x [5]=y); echo "${a[@]@A}"')).out)
    .toBe('declare -a a=([2]="x" [5]="y")\n');
  const tab = await run('declare -a a=("normal" $\'x\\ty\'); echo "${a[@]@A}"');
  expect(tab.out).toBe('declare -a a=([0]="normal" [1]=$\'x\\ty\')\n');
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

test('typeset is a synonym for declare', async () => {
  expect((await run('typeset -a arr=(p q r); echo "[${arr[1]}]"')).out).toBe('[q]\n');
  expect((await run('typeset -i n=5+5; echo "$n"')).out).toBe('10\n');
  expect((await run('type -t typeset', PATHENV, pathFs())).out).toBe('builtin\n');
});

test('declare/typeset is function-local by default; -g forces global', async () => {
  // bare declare in a function shadows the global as a local (restored on return).
  expect((await run('s=global; f() { declare s=local; echo "in=$s"; }; f; echo "out=$s"')).out)
    .toBe('in=local\nout=global\n');
  expect((await run('s=g; f() { typeset s=ts; }; f; echo "out=$s"')).out).toBe('out=g\n');
  // -g forces global for scalars AND arrays/assoc.
  expect((await run('arr=(a b c); f() { declare -g arr=(x y); }; f; echo "out:${arr[@]}"')).out)
    .toBe('out:x y\n');
  expect((await run('x=g; f() { declare -g x=glob; }; f; echo "out=$x"')).out).toBe('out=glob\n');
  expect((await run('f() { declare -gA m=([k]=v); }; f; echo "m=${m[k]}"')).out).toBe('m=v\n');
});

test('readonly/export in a function are GLOBAL (not local)', async () => {
  expect((await run('s=g; f() { readonly s=ro; }; f; echo "out=$s"')).out).toBe('out=ro\n');
  expect((await run('s=g; f() { export s=ex; }; f; echo "out=$s"')).out).toBe('out=ex\n');
});

test('a function-local readonly/nameref/integer attribute does NOT leak on return', async () => {
  // local -r: the readonly attr is gone after return, so the outer reassign succeeds.
  const ro = await run('f(){ local -r x=5; }; f; x=9; echo "[$x]"');
  expect(ro.out).toBe('[9]\n'); expect(ro.err).toBe('');
  // declare -n / local -n: the nameref mapping is local and restored on return.
  expect((await run('f(){ declare -n ref=g; }; g=hi; f; echo "[${ref-UNSET}]"')).out).toBe('[UNSET]\n');
  expect((await run('f(){ local -n r=g; echo "[$r]"; }; g=hi; f')).out).toBe('[hi]\n');
  // local -A registers an assoc; scoped + restored.
  expect((await run('declare -A g=([k]=1); f(){ local -A g=([x]=9); }; f; echo "gk=${g[k]-U} gx=${g[x]-U}"')).out)
    .toBe('gk=1 gx=U\n');
});

test('a bare local NAME (no value) shadows the outer scalar/array/assoc with EMPTY', async () => {
  expect((await run('x=global; f(){ local x; echo "in=[${x-UNSET}]"; }; f; echo "out=[$x]"')).out)
    .toBe('in=[UNSET]\nout=[global]\n');
  expect((await run('a=(1 2 3); f(){ local a; echo "in=[${a[@]}] n=${#a[@]}"; }; f; echo "out=[${a[@]}]"')).out)
    .toBe('in=[] n=0\nout=[1 2 3]\n');
});

test('declare -g updates the global even when a same-name local shadows it', async () => {
  // Inner sets -g while outer has a local: the local stays until return, then global shows.
  expect((await run('outer(){ local v=1; inner; echo "mid=$v"; }; inner(){ declare -g v=G; }; outer; echo "out=$v"')).out)
    .toBe('mid=1\nout=G\n');
  expect((await run('g(){ local v=1; declare -g v=G; echo "in=$v"; }; g; echo "after=$v"')).out)
    .toBe('in=1\nafter=G\n');
  expect((await run('v=start; f(){ declare -g v=G; }; f; echo "top=$v"')).out).toBe('top=G\n');
  // declare -g ARRAY with a local shadow updates the global array (local stays until return).
  expect((await run('f(){ local arr=(a b); declare -g arr=(x y z); echo "in=${arr[*]}"; }; arr=(g0); f; echo "out=${arr[*]}"')).out)
    .toBe('in=a b\nout=x y z\n');
  // a readonly LOCAL does NOT block declare -g to the (non-readonly) global.
  expect((await run('f(){ local x=1; readonly x; declare -g x=2; echo "in=$x"; }; x=0; f; echo "out=$x"')).out)
    .toBe('in=1\nout=2\n');
  // a genuinely GLOBAL readonly still blocks declare -g.
  expect((await run('readonly R=1; declare -g R=2; echo "$R"')).err).toMatch(/readonly/);
});

test('read -a / mapfile assign GLOBALLY inside a function (not local)', async () => {
  expect((await run('a=(old); f(){ read -a a <<< "new1 new2"; }; f; echo "[${a[@]}]"')).out)
    .toBe('[new1 new2]\n');
});

test('a bare assignment inside a function modifies the GLOBAL (not auto-local)', async () => {
  expect((await run('x=g; f() { x=new; }; f; echo "out=$x"')).out).toBe('out=new\n');
  expect((await run('a=(g); f() { a=(new); }; f; echo "out=${a[@]}"')).out).toBe('out=new\n');
});

test('local outside a function is an error (rc 1)', async () => {
  const r = await run('local x=1; echo "code=$?"');
  expect(r.out).toBe('code=1\n');
  expect(r.err).toMatch(/can only be used in a function/);
});

test('a repeated local += appends to the current local (fresh local += starts empty)', async () => {
  expect((await run('f(){ local -i c=3; local -i c+=2; echo "$c"; }; f')).out).toBe('5\n');
  // A FRESH local shadowing a global starts empty, so += appends to '' not the global.
  expect((await run('s=global; f(){ local s+=X; echo "$s"; }; f')).out).toBe('X\n');
});

test('a command-prefix assignment is transient for env builtins too (X=1 declare …)', async () => {
  expect((await run('X=1 declare foo=2; echo "foo=$foo X=[$X]"')).out).toBe('foo=2 X=[]\n');
  expect((await run('X=1 export q=2; echo "X=[$X] q=$q"')).out).toBe('X=[] q=2\n');
  // when the prefix key IS the operand, the operand value persists.
  expect((await run('X=1 export X=2; echo "X=$X"')).out).toBe('X=2\n');
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
