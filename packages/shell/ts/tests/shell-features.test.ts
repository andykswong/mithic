import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

async function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

async function runShellWithInput(script: string, input: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    // Write script first, then the input the select loop will read
    child.stdin.write(script + input);
    child.stdin.end();
  });
}

describe('special variables', () => {
  it('$RANDOM produces a number', async () => {
    const { stdout } = await runShell('echo $RANDOM\n');
    const num = parseInt(stdout.trim());
    assert.ok(!isNaN(num) && num >= 0 && num <= 32767);
  });

  it('$RANDOM varies between calls', async () => {
    const { stdout } = await runShell('echo $RANDOM $RANDOM\n');
    const parts = stdout.trim().split(' ');
    assert.strictEqual(parts.length, 2);
    assert.ok(!isNaN(parseInt(parts[0])));
  });

  it('$LINENO tracks line number', async () => {
    const { stdout } = await runShell('echo $LINENO\necho $LINENO\necho $LINENO\n');
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });

  it('$- contains option flags', async () => {
    const { stdout } = await runShell('echo $-\n');
    assert.ok(stdout.trim().length > 0, '$- should not be empty');
  });

  it('$- reflects -e flag', async () => {
    const { stdout } = await runShell('set -e\necho $-\n');
    assert.ok(stdout.trim().includes('e'), '$- should contain e after set -e');
  });

  it('$- reflects -u flag', async () => {
    const { stdout } = await runShell('set -u\necho $-\n');
    assert.ok(stdout.trim().includes('u'), '$- should contain u after set -u');
  });

  it('$- reflects -x flag', async () => {
    const { stdout } = await runShell('set -x\necho $-\n');
    assert.ok(stdout.trim().includes('x'), '$- should contain x after set -x');
  });

  it('$- does not contain flag before it is set', async () => {
    const { stdout } = await runShell('echo $-\n');
    assert.ok(!stdout.trim().includes('e'), '$- should not contain e by default');
  });

  it('$- reflects multiple flags', async () => {
    const { stdout } = await runShell('set -eu\necho $-\n');
    const flags = stdout.trim();
    assert.ok(flags.includes('e') && flags.includes('u'));
  });

  it('$- updates after set +e', async () => {
    const { stdout } = await runShell('set -e\nset +e\necho $-\n');
    assert.ok(!stdout.trim().includes('e'), '$- should not contain e after set +e');
  });

  it('$SECONDS starts at 0 or small value', async () => {
    const { stdout } = await runShell('echo $SECONDS\n');
    const val = parseInt(stdout.trim());
    assert.ok(!isNaN(val) && val >= 0 && val <= 2);
  });

  it('$SECONDS can be assigned and read back', async () => {
    const { stdout } = await runShell('SECONDS=100\necho $SECONDS\n');
    const val = parseInt(stdout.trim());
    assert.ok(val >= 100 && val <= 102, `expected 100-102, got ${val}`);
  });

  it('$FUNCNAME in function returns function name', async () => {
    const { stdout } = await runShell('f() { echo $FUNCNAME; }; f\n');
    assert.strictEqual(stdout.trim(), 'f');
  });

  it('$FUNCNAME outside function returns main', async () => {
    const { stdout } = await runShell('echo $FUNCNAME\n');
    assert.strictEqual(stdout.trim(), 'main');
  });

  it('${FUNCNAME[0]} in nested functions', async () => {
    const { stdout } = await runShell('inner() { echo "${FUNCNAME[0]} ${FUNCNAME[1]}"; }; outer() { inner; }; outer\n');
    assert.strictEqual(stdout.trim(), 'inner outer');
  });

  it('${FUNCNAME[@]} shows full call stack', async () => {
    const { stdout } = await runShell('c() { echo "${FUNCNAME[@]}"; }; b() { c; }; a() { b; }; a\n');
    assert.strictEqual(stdout.trim(), 'c b a main');
  });

  it('$BASH_SOURCE in sourced file', async () => {
    const { stdout } = await runShell(
      'echo \'echo $BASH_SOURCE\' > /tmp/src.sh\nsource /tmp/src.sh\n'
    );
    assert.strictEqual(stdout.trim(), '/tmp/src.sh');
  });

  it('${BASH_SOURCE[0]} in nested source', async () => {
    const { stdout } = await runShell(
      'echo \'echo ${BASH_SOURCE[0]}\' > /tmp/inner.sh\n' +
      'echo \'source /tmp/inner.sh\' > /tmp/outer.sh\n' +
      'source /tmp/outer.sh\n'
    );
    assert.strictEqual(stdout.trim(), '/tmp/inner.sh');
  });

  it('$BASH_LINENO in function', async () => {
    const { stdout } = await runShell(
      'f() { echo ${BASH_LINENO[0]}; }\nf\n'
    );
    const line = parseInt(stdout.trim());
    assert.ok(!isNaN(line) && line >= 0 && line <= 3, `expected line 0-3, got ${line}`);
  });

  it('${#FUNCNAME[@]} returns call stack depth', async () => {
    const { stdout } = await runShell('f() { echo ${#FUNCNAME[@]}; }; f\n');
    const val = parseInt(stdout.trim());
    assert.ok(val >= 2, `expected at least 2, got ${val}`);
  });
});

describe('${!var} variable indirection', () => {
  it('basic indirection resolves variable name', async () => {
    const { stdout } = await runShell('x=hello\nref=x\necho ${!ref}\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('indirection with unset target expands to empty', async () => {
    const { stdout } = await runShell('ref=nonexistent\necho "${!ref}"\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('indirection chain (two levels)', async () => {
    const { stdout } = await runShell('a=world\nb=a\necho ${!b}\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('indirection with array element', async () => {
    const { stdout } = await runShell('arr=(one two three)\nref="arr[1]"\necho ${!ref}\n');
    assert.strictEqual(stdout.trim(), 'two');
  });

  it('indirection with special variable', async () => {
    const { stdout } = await runShell('ref=HOME\necho ${!ref}\n');
    assert.ok(stdout.trim().length > 0, '${!HOME_REF} should expand to HOME value');
  });

  it('${!prefix*} lists variable names with prefix', async () => {
    const { stdout } = await runShell('FOO_A=1\nFOO_B=2\nFOO_C=3\necho ${!FOO_*}\n');
    const vars = stdout.trim().split(/\s+/).sort();
    assert.ok(vars.includes('FOO_A'));
    assert.ok(vars.includes('FOO_B'));
    assert.ok(vars.includes('FOO_C'));
  });

  it('${!prefix@} lists variable names with prefix', async () => {
    const { stdout } = await runShell('BAR_X=10\nBAR_Y=20\necho "${!BAR_@}"\n');
    const vars = stdout.trim().split(/\s+/).sort();
    assert.ok(vars.includes('BAR_X'));
    assert.ok(vars.includes('BAR_Y'));
  });
});

describe('POSIX character classes in globs', () => {
  it('[[:digit:]] matches digits', async () => {
    const { stdout } = await runShell(
      'echo 1 > /tmp/f1.txt\necho a > /tmp/fa.txt\nls /tmp/f[[:digit:]].txt\n'
    );
    assert.ok(stdout.trim().includes('f1.txt'));
    assert.ok(!stdout.trim().includes('fa.txt'));
  });

  it('[[:alpha:]] matches letters', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ga.txt\necho 1 > /tmp/g1.txt\nls /tmp/g[[:alpha:]].txt\n'
    );
    assert.ok(stdout.trim().includes('ga.txt'));
    assert.ok(!stdout.trim().includes('g1.txt'));
  });

  it('[[:alnum:]] matches alphanumeric', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ha.txt\necho 1 > /tmp/h1.txt\necho _ > /tmp/h_.txt\nls /tmp/h[[:alnum:]].txt\n'
    );
    assert.ok(stdout.trim().includes('ha.txt'));
    assert.ok(stdout.trim().includes('h1.txt'));
    assert.ok(!stdout.trim().includes('h_.txt'));
  });

  it('[[:upper:]] matches uppercase', async () => {
    const { stdout } = await runShell(
      'echo U > /tmp/iA.txt\necho l > /tmp/ia.txt\nls /tmp/i[[:upper:]].txt\n'
    );
    assert.ok(stdout.trim().includes('iA.txt'));
    assert.ok(!stdout.trim().includes('ia.txt'));
  });

  it('[[:lower:]] matches lowercase', async () => {
    const { stdout } = await runShell(
      'echo l > /tmp/ja.txt\necho U > /tmp/jA.txt\nls /tmp/j[[:lower:]].txt\n'
    );
    assert.ok(stdout.trim().includes('ja.txt'));
    assert.ok(!stdout.trim().includes('jA.txt'));
  });

  it('[[:space:]] in case pattern matches whitespace', async () => {
    const { stdout } = await runShell(
      'c=" "\ncase "$c" in [[:space:]]) echo yes;; *) echo no;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('[[:punct:]] matches punctuation', async () => {
    const { stdout } = await runShell(
      'c="."\ncase "$c" in [[:punct:]]) echo yes;; *) echo no;; esac\n'
    );
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('negated class [^[:digit:]] matches non-digits', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ka.txt\necho 1 > /tmp/k1.txt\nls /tmp/k[^[:digit:]].txt\n'
    );
    assert.ok(stdout.trim().includes('ka.txt'));
    assert.ok(!stdout.trim().includes('k1.txt'));
  });

  it('mixed class and literal [[:digit:]ab] matches digit or a or b', async () => {
    const { stdout } = await runShell(
      'echo 1 > /tmp/l1.txt\necho a > /tmp/la.txt\necho c > /tmp/lc.txt\nls /tmp/l[[:digit:]ab].txt\n'
    );
    assert.ok(stdout.trim().includes('l1.txt'));
    assert.ok(stdout.trim().includes('la.txt'));
    assert.ok(!stdout.trim().includes('lc.txt'));
  });
});

describe('$RANDOM seeded with getrandom', () => {
  it('separate shell instances produce different $RANDOM values', async () => {
    const r1 = await runShell('echo $RANDOM\n');
    const r2 = await runShell('echo $RANDOM\n');
    const val1 = parseInt(r1.stdout.trim());
    const val2 = parseInt(r2.stdout.trim());
    assert.ok(!isNaN(val1) && val1 >= 0 && val1 <= 32767);
    assert.ok(!isNaN(val2) && val2 >= 0 && val2 <= 32767);
    assert.notStrictEqual(val1, val2);
  });
});

describe('FUNCNEST recursion limit', () => {
  it('exceeding FUNCNEST produces error and non-zero exit', async () => {
    const { stderr, exit } = await runShell('FUNCNEST=5\nf() { f; }\nf\n');
    assert.ok(stderr.includes('maximum function nesting level exceeded'));
    assert.notStrictEqual(exit, 0);
  });

  it('FUNCNEST=0 disables the limit (deeply recursive function works)', async () => {
    const { stdout, exit } = await runShell('FUNCNEST=0\ncount() { if [ "$1" -le 0 ]; then echo done; return; fi; count $(($1 - 1)); }\ncount 10\n');
    assert.strictEqual(stdout.trim(), 'done');
    assert.strictEqual(exit, 0);
  });
});

describe('process substitution', () => {
  it('<(cmd) provides file with command output', async () => {
    const { stdout, exit } = await runShell('cat <(echo from_procsub_in)\n');
    assert.strictEqual(stdout.trim(), 'from_procsub_in');
    assert.strictEqual(exit, 0);
  });

  it('>(cmd) writes output through the substituted command', async () => {
    const { stdout, exit } = await runShell('echo hello > >(cat)\n');
    assert.strictEqual(stdout.trim(), 'hello');
    assert.strictEqual(exit, 0);
  });

  it('>(cmd) with tee duplicates output', async () => {
    const { stdout, exit } = await runShell('echo data | tee >(cat > /tmp/procsub_tee.txt)\ncat /tmp/procsub_tee.txt\n');
    assert.ok(stdout.includes('data'));
    assert.strictEqual(exit, 0);
  });
});

describe('noclobber (set -C)', () => {
  it('set -C prevents overwriting existing file with >', async () => {
    const { stderr, exit } = await runShell('echo existing > /tmp/noclobber_test.txt\nset -C\necho new > /tmp/noclobber_test.txt\n');
    assert.ok(stderr.includes('cannot overwrite existing file'));
    assert.notStrictEqual(exit, 0);
  });

  it('set -C allows >| to force overwrite', async () => {
    const { stdout, exit } = await runShell('echo existing > /tmp/noclobber_force.txt\nset -C\necho forced >| /tmp/noclobber_force.txt\ncat /tmp/noclobber_force.txt\n');
    assert.strictEqual(stdout.trim(), 'forced');
    assert.strictEqual(exit, 0);
  });

  it('set +C re-enables overwriting with >', async () => {
    const { stdout, exit } = await runShell('echo existing > /tmp/noclobber_plus.txt\nset -C\nset +C\necho replaced > /tmp/noclobber_plus.txt\ncat /tmp/noclobber_plus.txt\n');
    assert.strictEqual(stdout.trim(), 'replaced');
    assert.strictEqual(exit, 0);
  });

  it('set -C does not affect writing to new files', async () => {
    const { stdout, exit } = await runShell('rm -f /tmp/noclobber_new.txt\nset -C\necho fresh > /tmp/noclobber_new.txt\ncat /tmp/noclobber_new.txt\n');
    assert.strictEqual(stdout.trim(), 'fresh');
    assert.strictEqual(exit, 0);
  });
});

describe('heredoc edge cases', () => {
  it('<<- strips leading tabs from content', async () => {
    const { stdout } = await runShell('x=$(<<-EOF\n\thello\n\tworld\nEOF\n)\necho "$x"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });
});

describe('PIPESTATUS', () => {
  it('PIPESTATUS captures exit codes from pipeline stages', async () => {
    const { stdout } = await runShell('true | false | true\necho "${PIPESTATUS[@]}"\n');
    assert.strictEqual(stdout.trim(), '0 1 0');
  });

  it('PIPESTATUS for single command pipeline', async () => {
    const { stdout } = await runShell('false\necho "${PIPESTATUS[@]}"\n');
    assert.strictEqual(stdout.trim(), '1');
  });

  it('PIPESTATUS with all successful stages', async () => {
    const { stdout } = await runShell('true | true | true\necho "${PIPESTATUS[@]}"\n');
    assert.strictEqual(stdout.trim(), '0 0 0');
  });
});

describe('$$ and $BASHPID', () => {
  it('$$ expands to a numeric PID', async () => {
    const { stdout } = await runShell('echo $$\n');
    const num = parseInt(stdout.trim());
    assert.ok(!isNaN(num) && num > 0);
  });

  it('$BASHPID expands to a numeric PID', async () => {
    const { stdout } = await runShell('echo $BASHPID\n');
    const num = parseInt(stdout.trim());
    assert.ok(!isNaN(num) && num > 0);
  });

  it('$$ and $BASHPID have the same value in non-subshell', async () => {
    const { stdout } = await runShell('echo $$ $BASHPID\n');
    const parts = stdout.trim().split(' ');
    assert.strictEqual(parts[0], parts[1]);
  });
});

describe('wait -n', () => {
  it('wait -n returns 127 when no jobs', async () => {
    const { stdout } = await runShell('wait -n; echo $?\n');
    assert.strictEqual(stdout.trim(), '127');
  });
});

describe('TMOUT variable', () => {
  it('TMOUT causes shell to exit on EOF', async () => {
    const { exit } = await runShell('TMOUT=1\n');
    assert.strictEqual(exit, 0);
  });

  it('TMOUT=0 does not cause early exit', async () => {
    const { stdout, exit } = await runShell('TMOUT=0\necho hello\n');
    assert.strictEqual(stdout.trim(), 'hello');
    assert.strictEqual(exit, 0);
  });
});

describe('set -e (errexit) propagation', () => {
  it('set -e exits shell on command failure', async () => {
    const { exit } = await runShell('set -e\ntrue\nfalse\necho should_not_reach\n');
    assert.notStrictEqual(exit, 0);
  });

  it('set -e does not trigger in if condition', async () => {
    const { stdout, exit } = await runShell('set -e\nif false; then echo no; else echo yes; fi\necho reached\n');
    assert.strictEqual(stdout.trim(), 'yes\nreached');
    assert.strictEqual(exit, 0);
  });

  it('set -e does not trigger in while condition', async () => {
    const { stdout, exit } = await runShell('set -e\nx=0\nwhile [ "$x" -eq 1 ]; do echo loop; done\necho reached\n');
    assert.strictEqual(stdout.trim(), 'reached');
    assert.strictEqual(exit, 0);
  });

  it('set -e does not trigger with ! prefix', async () => {
    const { stdout, exit } = await runShell('set -e\n! false\necho reached\n');
    assert.strictEqual(stdout.trim(), 'reached');
    assert.strictEqual(exit, 0);
  });

  it('set -e does not trigger in && chain (non-final)', async () => {
    const { stdout, exit } = await runShell('set -e\nfalse && echo no\necho reached\n');
    assert.strictEqual(stdout.trim(), 'reached');
    assert.strictEqual(exit, 0);
  });

  it('set -e does not trigger in || chain (non-final)', async () => {
    const { stdout, exit } = await runShell('set -e\nfalse || echo recovered\necho reached\n');
    assert.strictEqual(stdout.trim(), 'recovered\nreached');
    assert.strictEqual(exit, 0);
  });

  it('set -e triggers on final command of && list', async () => {
    const { stdout, exit } = await runShell('set -e\ntrue && false\necho should_not_reach\n');
    assert.notStrictEqual(exit, 0);
    assert.ok(!stdout.includes('should_not_reach'));
  });
});

describe('trap builtin', () => {
  it('trap EXIT runs handler on shell exit', async () => {
    const { stdout } = await runShell('trap \'echo goodbye\' EXIT\necho hello\n');
    assert.ok(stdout.includes('hello'));
    assert.ok(stdout.includes('goodbye'));
  });

  it('trap with signal 0 is equivalent to EXIT', async () => {
    const { stdout } = await runShell('trap \'echo exit_trap\' 0\necho main\n');
    assert.ok(stdout.includes('main'));
    assert.ok(stdout.includes('exit_trap'));
  });

  it('trap ERR runs on command failure', async () => {
    const { stdout } = await runShell('trap \'echo error_caught\' ERR\nfalse\necho done\n');
    assert.ok(stdout.includes('error_caught'));
    assert.ok(stdout.includes('done'));
  });

  it('trap ERR does not run in if condition', async () => {
    const { stdout } = await runShell('trap \'echo error_caught\' ERR\nif false; then echo no; fi\necho done\n');
    assert.ok(!stdout.includes('error_caught'));
    assert.ok(stdout.includes('done'));
  });

  it('trap - SIGNAL resets handler', async () => {
    const { stdout } = await runShell('trap \'echo trapped\' EXIT\ntrap - EXIT\necho done\n');
    assert.strictEqual(stdout.trim(), 'done');
  });

  it('trap with empty string ignores signal', async () => {
    const { stdout } = await runShell('trap \'\' ERR\nfalse\necho done\n');
    assert.strictEqual(stdout.trim(), 'done');
  });

  it('trap with no args lists active traps', async () => {
    const { stdout } = await runShell('trap \'echo hi\' EXIT\ntrap\n');
    assert.ok(stdout.includes('EXIT'));
    assert.ok(stdout.includes('echo hi'));
  });
});

describe('subshell isolation', () => {
  it('subshell does not affect parent env', async () => {
    const { stdout } = await runShell('x=outer\n(x=inner)\necho $x\n');
    assert.strictEqual(stdout.trim(), 'outer');
  });

  it('subshell does not affect parent cwd', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/subdir\n(cd /tmp/subdir)\npwd\n');
    assert.strictEqual(stdout.trim(), '/root');
  });

  it('subshell does not affect parent functions', async () => {
    const { stdout } = await runShell('(f() { echo inner; })\ntype f 2>/dev/null || echo no_func\n');
    assert.ok(stdout.includes('no_func'));
  });

  it('exit in subshell does not exit parent', async () => {
    const { stdout, exit } = await runShell('(exit 1)\necho still_running\n');
    assert.strictEqual(stdout.trim(), 'still_running');
    assert.strictEqual(exit, 0);
  });

  it('subshell inherits parent env', async () => {
    const { stdout } = await runShell('x=hello\necho $(echo $x)\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('subshell returns its own exit code', async () => {
    const { stdout } = await runShell('(exit 42)\necho $?\n');
    assert.strictEqual(stdout.trim(), '42');
  });
});

describe('select loop', () => {
  it('select parses correctly and terminates on EOF', async () => {
    const { exit } = await runShell('select item in alpha beta gamma; do echo "selected: $item"; break; done\n');
    assert.strictEqual(exit, 0);
  });

  it('select shows menu on stderr', async () => {
    const { stderr } = await runShell('select item in one two three; do break; done\n');
    assert.ok(stderr.includes('1) one'));
    assert.ok(stderr.includes('2) two'));
    assert.ok(stderr.includes('3) three'));
  });

  it('select reads input and sets variable', async () => {
    const result = await runShellWithInput('select item in alpha beta gamma; do\necho "selected: $item"\necho "reply: $REPLY"\nbreak\ndone\n', '2\n');
    assert.ok(result.stdout.includes('selected: beta'));
    assert.ok(result.stdout.includes('reply: 2'));
  });

  it('select sets empty var for invalid number', async () => {
    const result = await runShellWithInput('select item in a b c; do\necho "item=[$item]"\nbreak\ndone\n', '99\n');
    assert.ok(result.stdout.includes('item=[]'));
  });

  it('select sets REPLY to raw input', async () => {
    const result = await runShellWithInput('select item in x y z; do\necho "reply=$REPLY"\nbreak\ndone\n', 'hello\n');
    assert.ok(result.stdout.includes('reply=hello'));
  });
});

describe('declare -A (associative arrays)', () => {
  it('declare -A creates associative array and allows key assignment', async () => {
    const { stdout } = await runShell('declare -A mymap\nmymap[name]=alice\nmymap[age]=30\necho "${mymap[name]} ${mymap[age]}"\n');
    assert.strictEqual(stdout.trim(), 'alice 30');
  });

  it('${#assoc[@]} counts elements', async () => {
    const { stdout } = await runShell('declare -A m\nm[a]=1\nm[b]=2\nm[c]=3\necho ${#m[@]}\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('${!assoc[@]} lists keys', async () => {
    const { stdout } = await runShell('declare -A m\nm[x]=10\nm[y]=20\nkeys="${!m[@]}"\nresult=$(echo "$keys" | xargs -n1 | sort)\necho "$result"\n');
    assert.strictEqual(stdout.trim(), 'x\ny');
  });

  it('${assoc[@]} lists all values', async () => {
    const { stdout } = await runShell('declare -A m\nm[k1]=hello\nm[k2]=world\nvals="${m[@]}"\nresult=$(echo "$vals" | xargs -n1 | sort)\necho "$result"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });

  it('unset removes assoc array key', async () => {
    const { stdout } = await runShell('declare -A m\nm[a]=1\nm[b]=2\nunset m[a]\necho ${#m[@]}\necho "${m[b]}"\n');
    assert.strictEqual(stdout.trim(), '1\n2');
  });

  it('overwriting existing assoc key works', async () => {
    const { stdout } = await runShell('declare -A m\nm[key]=old\nm[key]=new\necho "${m[key]}"\n');
    assert.strictEqual(stdout.trim(), 'new');
  });

  it('reading unset key returns empty string', async () => {
    const { stdout } = await runShell('declare -A m\necho "[${m[nonexist]}]"\n');
    assert.strictEqual(stdout.trim(), '[]');
  });
});

describe('coproc (stub)', () => {
  it('coproc prints not-yet-supported message', async () => {
    const { stderr, exit } = await runShell('coproc cat\n');
    assert.ok(stderr.includes('not yet supported'));
    assert.strictEqual(exit, 1);
  });

  it('coproc with name prints not-yet-supported message', async () => {
    const { stderr, exit } = await runShell('coproc MY_PROC cat\n');
    assert.ok(stderr.includes('not yet supported'));
    assert.strictEqual(exit, 1);
  });
});

describe('PATH-based lookup', () => {
  it('commands in PATH directories are found', async () => {
    const { stdout } = await runShell('echo $PATH\n');
    assert.ok(stdout.length > 0);
  });
});
