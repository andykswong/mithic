import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

async function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI], {
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

describe('builtin: exec', () => {
  it('exec with redirect changes shell stdout', async () => {
    const { stdout } = await runShell('exec > /tmp/exec_out.txt\necho hello\nexec > /dev/stdout\necho "$(< /tmp/exec_out.txt)"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

describe('builtin: readonly', () => {
  it('readonly prevents reassignment', async () => {
    const { stderr, exit } = await runShell('readonly x=10\nx=20\n');
    assert.ok(stderr.includes('readonly'));
    assert.notStrictEqual(exit, 0);
  });

  it('readonly var retains value', async () => {
    const { stdout } = await runShell('readonly x=hello\necho $x\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

describe('builtin: let', () => {
  it('let evaluates arithmetic', async () => {
    const { stdout } = await runShell('let x=5+3\necho $x\n');
    assert.strictEqual(stdout.trim(), '8');
  });

  it('let returns 1 for zero result', async () => {
    const { exit } = await runShell('let "0"\n');
    assert.strictEqual(exit, 1);
  });
});

describe('builtin: getopts', () => {
  it('getopts parses flags', async () => {
    const { stdout } = await runShell('f() { while getopts "ab:c" opt; do echo "$opt=$OPTARG"; done; }; f -a -b val -c\n');
    assert.strictEqual(stdout.trim(), 'a=\nb=val\nc=');
  });
});

describe('builtin: mapfile/readarray', () => {
  it('mapfile reads lines into array', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" > /tmp/mf.txt\nmapfile -t lines < /tmp/mf.txt\necho ${#lines[@]}\necho ${lines[1]}\n');
    assert.strictEqual(stdout.trim(), '3\nb');
  });
});

describe('builtin: hash', () => {
  it('hash with no args prints empty table', async () => {
    const { exit } = await runShell('hash\n');
    assert.strictEqual(exit, 0);
  });

  it('hash -r clears without error', async () => {
    const { exit } = await runShell('hash -r\n');
    assert.strictEqual(exit, 0);
  });

  it('hash caches command path for future lookups', async () => {
    const { stdout, exit } = await runShell('mkdir -p /usr/bin && touch /usr/bin/mycmd; hash mycmd; hash\n');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('mycmd=/usr/bin/mycmd'));
  });

  it('hash -r clears cached paths', async () => {
    const { stdout, exit } = await runShell('mkdir -p /usr/bin && touch /usr/bin/mycmd; hash mycmd; hash -r; hash\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '');
  });

  it('hash reports not found for missing command', async () => {
    const { exit, stderr } = await runShell('hash nonexistent_cmd\n');
    assert.strictEqual(exit, 1);
    assert.ok(stderr.includes('not found'));
  });
});

describe('builtin: fg error handling', () => {
  it('fg %99 outputs error for nonexistent job', async () => {
    const { stderr, exit } = await runShell('fg %99\n');
    assert.ok(stderr.includes('no such job'));
    assert.strictEqual(exit, 1);
  });
});

describe('prefix assignment: VAR=val cmd', () => {
  it('prefix assignment passes env to command', async () => {
    const { stdout } = await runShell('f() { echo $MY_VAR; }; MY_VAR=hello f\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('prefix assignment does not persist after command', async () => {
    const { stdout } = await runShell('f() { echo $MY_VAR; }; MY_VAR=hello f\necho "${MY_VAR:-unset}"\n');
    assert.strictEqual(stdout.trim(), 'hello\nunset');
  });

  it('multiple prefix assignments', async () => {
    const { stdout } = await runShell('f() { echo "$A $B"; }; A=1 B=2 f\n');
    assert.strictEqual(stdout.trim(), '1 2');
  });
});

describe('export without value', () => {
  it('export VAR marks existing var for export', async () => {
    const { stdout } = await runShell('x=hello\nexport x\nenv | grep "^x="\n');
    assert.strictEqual(stdout.trim(), 'x=hello');
  });

  it('export VAR=val and export VAR both work', async () => {
    const { stdout } = await runShell('export y=world\nenv | grep "^y="\n');
    assert.strictEqual(stdout.trim(), 'y=world');
  });
});

describe('builtin: alias/unalias', () => {
  it('alias defines a command shortcut (posix mode expands in scripts)', async () => {
    const { stdout } = await runShell('set -o posix\nalias greet="echo hello"\ngreet\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('alias with no args lists all aliases', async () => {
    const { stdout } = await runShell('alias foo="bar"\nalias baz="qux"\nalias\n');
    assert.ok(stdout.includes("alias baz='qux'"));
    assert.ok(stdout.includes("alias foo='bar'"));
  });

  it('alias name prints that alias', async () => {
    const { stdout } = await runShell('alias x="echo hi"\nalias x\n');
    assert.ok(stdout.includes("alias x='echo hi'"));
  });

  it('unalias removes an alias', async () => {
    const { stdout } = await runShell('alias greet="echo hello"\nunalias greet\ngreet 2>/dev/null || echo gone\n');
    assert.strictEqual(stdout.trim(), 'gone');
  });

  it('unalias -a clears all aliases', async () => {
    const { stdout } = await runShell('alias a="echo 1"\nalias b="echo 2"\nunalias -a\nalias\n');
    assert.strictEqual(stdout.trim(), '');
  });

  it('alias expansion passes arguments (posix mode)', async () => {
    const { stdout } = await runShell('set -o posix\nalias say="echo"\nsay world\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('alias not expanded in non-interactive bash mode', async () => {
    const { stdout } = await runShell('alias greet="echo hello"\ngreet 2>/dev/null || echo not_found\n');
    assert.strictEqual(stdout.trim(), 'not_found');
  });
});

describe('builtin: time', () => {
  it('time prints elapsed time to stderr', async () => {
    const { stderr } = await runShell('time echo hello\n');
    assert.ok(stderr.includes('real'));
    assert.match(stderr, /\d+m[\d.]+s/);
  });

  it('time with no command prints zero time', async () => {
    const { stderr } = await runShell('time\n');
    assert.ok(stderr.includes('real'));
  });

  it('time returns exit code of timed command', async () => {
    const { exit } = await runShell('time false\n');
    assert.strictEqual(exit, 1);
  });
});

describe('builtin: builtin', () => {
  it('builtin invokes a shell builtin directly', async () => {
    const { stdout } = await runShell('builtin echo hello\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('builtin bypasses functions', async () => {
    const { stdout } = await runShell('echo() { printf "FUNC %s" "$1"; }\nbuiltin echo real\n');
    assert.strictEqual(stdout.trim(), 'real');
  });

  it('builtin returns error for non-builtins', async () => {
    const { stderr, exit } = await runShell('builtin nonexistent_xyz\n');
    assert.ok(stderr.includes('not a shell builtin'));
    assert.strictEqual(exit, 1);
  });
});

describe('builtin: type and command -v (PATH resolution)', () => {
  it('type finds scripts in PATH', async () => {
    const { stdout } = await runShell('mkdir -p /usr/bin\necho "#!/bin/sh" > /usr/bin/myscript\nchmod +x /usr/bin/myscript\ntype myscript\n');
    assert.ok(stdout.includes('myscript is'), `expected 'myscript is' in: ${stdout}`);
  });

  it('command -v finds scripts in PATH', async () => {
    const { stdout } = await runShell('mkdir -p /usr/bin\necho "#!/bin/sh" > /usr/bin/myscript2\nchmod +x /usr/bin/myscript2\ncommand -v myscript2\n');
    assert.ok(stdout.trim().includes('/usr/bin/myscript2'));
  });

  it('type identifies functions', async () => {
    const { stdout } = await runShell('myfn() { echo x; }\ntype myfn\n');
    assert.ok(stdout.includes('function'));
  });

  it('command -v finds functions', async () => {
    const { stdout } = await runShell('myfn() { echo x; }\ncommand -v myfn\n');
    assert.strictEqual(stdout.trim(), 'myfn');
  });

  it('command executes external commands directly', async () => {
    const { stdout } = await runShell('command date "+%Y"\n');
    assert.match(stdout.trim(), /^\d{4}$/);
  });
});

describe('/dev/random and /dev/urandom', () => {
  it('/dev/random exists as a device', async () => {
    const { stdout } = await runShell('test -e /dev/random && echo yes || echo no\n');
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('/dev/urandom exists as a device', async () => {
    const { stdout } = await runShell('test -e /dev/urandom && echo yes || echo no\n');
    assert.strictEqual(stdout.trim(), 'yes');
  });

  it('/dev/random listed in ls /dev', async () => {
    const { stdout } = await runShell('ls /dev\n');
    assert.ok(stdout.includes('random'));
    assert.ok(stdout.includes('urandom'));
  });
});

describe('builtin: pushd/popd/dirs', () => {
  it('pushd changes directory and prints stack', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/a\npushd /tmp/a\n');
    assert.ok(stdout.includes('/tmp/a'));
  });

  it('pushd adds previous dir to stack', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/a\npushd /tmp/a\npwd\n');
    const lines = stdout.trim().split('\n');
    assert.ok(lines.some(l => l.trim() === '/tmp/a'));
  });

  it('popd returns to previous directory', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/a\npushd /tmp/a\npopd\npwd\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[lines.length - 1].trim(), '/');
  });

  it('popd on empty stack prints error', async () => {
    const { stderr, exit } = await runShell('popd\n');
    assert.ok(stderr.includes('directory stack empty'));
    assert.strictEqual(exit, 1);
  });

  it('dirs lists the stack', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/a\nmkdir -p /tmp/b\npushd /tmp/a\npushd /tmp/b\ndirs\n');
    const lines = stdout.trim().split('\n');
    const dirsLine = lines[lines.length - 1];
    assert.ok(dirsLine.includes('/tmp/b'));
    assert.ok(dirsLine.includes('/tmp/a'));
  });

  it('dirs -c clears the stack', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/a\nmkdir -p /tmp/b\npushd /tmp/a\npushd /tmp/b\ndirs -c\ndirs\n');
    const lines = stdout.trim().split('\n');
    const dirsLine = lines[lines.length - 1];
    // After dirs -c, only cwd (/tmp/b) should remain, no stack entries
    assert.ok(!dirsLine.includes('/tmp/a'));
    assert.ok(!dirsLine.includes(' /'));
  });

  it('pushd with no arg swaps top and cwd', async () => {
    const { stdout } = await runShell('mkdir -p /tmp/a\npushd /tmp/a\npushd\npwd\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[lines.length - 1].trim(), '/');
  });
});

describe('builtin: read flags (-d, -N, -u)', () => {
  it('read -d : splits on delimiter', async () => {
    const { stdout } = await runShell('echo "foo:bar" | read -d : x; echo $x\n');
    assert.strictEqual(stdout.trim(), 'foo');
  });

  it('read -N 3 reads exactly 3 chars', async () => {
    const { stdout } = await runShell('echo "hello" | read -N 3 x; echo $x\n');
    assert.strictEqual(stdout.trim(), 'hel');
  });

  it('read -N does not split on IFS', async () => {
    const { stdout } = await runShell('echo "a b c" | read -N 5 x; echo $x\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('read -u 0 reads from stdin (default)', async () => {
    const { stdout } = await runShell('echo hello | read -u 0 x; echo $x\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('read -u with non-zero fd returns error', async () => {
    const { stderr, exit } = await runShell('echo hello | read -u 3 x\n');
    assert.ok(stderr.includes('invalid file descriptor'));
    assert.notStrictEqual(exit, 0);
  });

  it('read -d with delimiter not found uses whole line', async () => {
    const { stdout } = await runShell('echo "abcdef" | read -d Z x; echo $x\n');
    assert.strictEqual(stdout.trim(), 'abcdef');
  });
});
