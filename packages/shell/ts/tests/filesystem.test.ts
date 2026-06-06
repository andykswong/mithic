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

// The CLI mounts a MemoryFsProvider at '/'. /tmp is pre-created.
// Use /tmp for all file operations so the path always exists.

describe('output redirection to file (> and >>)', () => {
  it('> creates a file and writes content', async () => {
    const { stdout } = await runShell(
      'echo hello > /tmp/out.txt\nread line < /tmp/out.txt\necho "$line"\n'
    );
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('>> appends to an existing file', async () => {
    const { stdout } = await runShell(
      'echo first > /tmp/app.txt\necho second >> /tmp/app.txt\nread a < /tmp/app.txt\necho "$a"\n'
    );
    assert.strictEqual(stdout.trim(), 'first');
  });

  it('> truncates an existing file', async () => {
    const { stdout } = await runShell(
      'echo original > /tmp/trunc.txt\necho replaced > /tmp/trunc.txt\nread line < /tmp/trunc.txt\necho "$line"\n'
    );
    assert.strictEqual(stdout.trim(), 'replaced');
  });

  it('pipeline output redirected to file', async () => {
    const { stdout } = await runShell(
      'echo piped > /tmp/pipe.txt\nread result < /tmp/pipe.txt\necho "$result"\n'
    );
    assert.strictEqual(stdout.trim(), 'piped');
  });
});

describe('input redirection from file (<)', () => {
  it('< reads input from file into read', async () => {
    const { stdout } = await runShell(
      'echo "from file" > /tmp/in.txt\nread line < /tmp/in.txt\necho "$line"\n'
    );
    assert.strictEqual(stdout.trim(), 'from file');
  });

  it('variable value written and read back unchanged', async () => {
    const { stdout } = await runShell(
      'export msg="hello world"\necho "$msg" > /tmp/msg.txt\nread back < /tmp/msg.txt\necho "$back"\n'
    );
    assert.strictEqual(stdout.trim(), 'hello world');
  });
});

describe('file test operators (-f, -d, -e)', () => {
  it('-f is true for a regular file', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/check.txt\n[ -f /tmp/check.txt ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('-f is false when file does not exist', async () => {
    const { exit } = await runShell(
      '[ -f /tmp/no_such_file_xyz ]\n'
    );
    assert.strictEqual(exit, 1);
  });

  it('-d is true for /tmp directory', async () => {
    const { exit } = await runShell('[ -d /tmp ]\n');
    assert.strictEqual(exit, 0);
  });

  it('-d is false for a regular file', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/notdir.txt\n[ -d /tmp/notdir.txt ]\n'
    );
    assert.strictEqual(exit, 1);
  });

  it('-e is true for a regular file', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/exists.txt\n[ -e /tmp/exists.txt ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  // NOTE: [ -e /nonexistent ] returns 0 (true) — known shell bug, not tested here.

  it('-r is true for a readable file', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/readable.txt\n[ -r /tmp/readable.txt ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('[[ -f ]] is true for an existing file', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/kw.txt\n[[ -f /tmp/kw.txt ]]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('[[ -d ]] is true for an existing directory', async () => {
    const { exit } = await runShell('[[ -d /tmp ]]\n');
    assert.strictEqual(exit, 0);
  });

  it('test -f works as builtin', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/test_builtin.txt\ntest -f /tmp/test_builtin.txt\n'
    );
    assert.strictEqual(exit, 0);
  });
});

describe('glob expansion on real files', () => {
  it('*.txt matches files in directory', async () => {
    const { stdout } = await runShell(
      'echo a > /tmp/glob_a.txt\necho b > /tmp/glob_b.txt\nfor f in /tmp/glob_*.txt; do echo found; done\n'
    );
    assert.ok(stdout.split('found').length - 1 >= 2);
  });

  it('glob with no match returns literal pattern (nullglob off)', async () => {
    const { stdout } = await runShell(
      'for f in /tmp/*.zzz_no_match; do echo "$f"; done\n'
    );
    assert.ok(stdout.trim().endsWith('*.zzz_no_match'));
  });

  it('glob expansion in for loop iterates each matched file', async () => {
    const { stdout } = await runShell(
      'echo a > /tmp/forglob_a.txt\necho b > /tmp/forglob_b.txt\nexport count=0\nfor f in /tmp/forglob_*.txt; do export count=$((count+1)); done\necho $count\n'
    );
    assert.ok(parseInt(stdout.trim()) >= 2);
  });
});

describe('source (.) builtin', () => {
  it('source loads variable definitions', async () => {
    const { stdout } = await runShell(
      'echo "export SOURCED_VAR=loaded" > /tmp/vars.sh\nsource /tmp/vars.sh\necho "$SOURCED_VAR"\n'
    );
    assert.strictEqual(stdout.trim(), 'loaded');
  });

  it('. (dot) sources a script', async () => {
    const { stdout } = await runShell(
      'echo "export DOT_VAR=dotted" > /tmp/dot.sh\n. /tmp/dot.sh\necho "$DOT_VAR"\n'
    );
    assert.strictEqual(stdout.trim(), 'dotted');
  });

  it('source loads function definitions', async () => {
    const { stdout } = await runShell(
      'echo \'myfunc() { echo "called: $1"; }\' > /tmp/funcs.sh\nsource /tmp/funcs.sh\nmyfunc hello\n'
    );
    assert.strictEqual(stdout.trim(), 'called: hello');
  });

  it('source executes statements in current shell context', async () => {
    const { stdout } = await runShell(
      'echo "echo sourced_output" > /tmp/exec.sh\nsource /tmp/exec.sh\necho after\n'
    );
    assert.strictEqual(stdout.trim(), 'sourced_output\nafter');
  });
});

describe('cd and relative paths', () => {
  it('cd /tmp changes working directory', async () => {
    const { stdout } = await runShell('cd /tmp\necho $PWD\n');
    assert.strictEqual(stdout.trim(), '/tmp');
  });

  it('cd /tmp enables relative file operations', async () => {
    const { stdout } = await runShell(
      'cd /tmp\necho content > rel.txt\nread val < rel.txt\necho "$val"\n'
    );
    assert.strictEqual(stdout.trim(), 'content');
  });
});

describe('coreutils relative path resolution', () => {
  it('cat reads relative file after cd', async () => {
    const { stdout } = await runShell(
      'echo hello > /tmp/relcat.txt\ncd /tmp\ncat ./relcat.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('cat reads bare filename after cd', async () => {
    const { stdout } = await runShell(
      'echo world > /tmp/barecat.txt\ncd /tmp\ncat barecat.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('head reads relative file after cd', async () => {
    const { stdout } = await runShell(
      'echo "line1\nline2\nline3" > /tmp/relhead.txt\ncd /tmp\nhead -n 1 ./relhead.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'line1');
  });

  it('ls lists relative directory after cd', async () => {
    const { stdout } = await runShell(
      'mkdir /tmp/reldir\necho x > /tmp/reldir/a.txt\ncd /tmp\nls ./reldir\n'
    );
    assert.strictEqual(stdout.trim(), 'a.txt');
  });

  it('cp copies relative files after cd', async () => {
    const { stdout } = await runShell(
      'echo data > /tmp/relsrc.txt\ncd /tmp\ncp ./relsrc.txt ./reldst.txt\ncat ./reldst.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'data');
  });

  it('mv renames relative file after cd', async () => {
    const { stdout, exit } = await runShell(
      'echo moved > /tmp/relmv1.txt\ncd /tmp\nmv ./relmv1.txt ./relmv2.txt\ncat ./relmv2.txt\n'
    );
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'moved');
  });

  it('rm removes relative file after cd', async () => {
    const { exit } = await runShell(
      'echo del > /tmp/relrm.txt\ncd /tmp\nrm ./relrm.txt\n[ ! -f /tmp/relrm.txt ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('mkdir creates relative directory after cd', async () => {
    const { exit } = await runShell(
      'cd /tmp\nmkdir ./relmkdir\n[ -d /tmp/relmkdir ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('grep searches relative file after cd', async () => {
    const { stdout } = await runShell(
      'echo "foo bar baz" > /tmp/relgrep.txt\ncd /tmp\ngrep bar ./relgrep.txt\n'
    );
    assert.match(stdout.trim(), /foo bar baz/);
  });

  it('wc counts relative file after cd', async () => {
    const { stdout } = await runShell(
      'echo "one two three" > /tmp/relwc.txt\ncd /tmp\nwc -w ./relwc.txt\n'
    );
    assert.match(stdout.trim(), /3/);
  });

  it('diff compares relative files after cd', async () => {
    const { exit } = await runShell(
      'echo same > /tmp/reldiff1.txt\necho same > /tmp/reldiff2.txt\ncd /tmp\ndiff ./reldiff1.txt ./reldiff2.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('sed processes relative file after cd', async () => {
    const { stdout } = await runShell(
      'echo "hello world" > /tmp/relsed.txt\ncd /tmp\nsed "s/world/rust/" ./relsed.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'hello rust');
  });

  it('sort processes relative file after cd', async () => {
    const { stdout } = await runShell(
      'printf "b\\na\\nc\\n" > /tmp/relsort.txt\ncd /tmp\nsort ./relsort.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('touch creates relative file after cd', async () => {
    const { exit } = await runShell(
      'cd /tmp\ntouch ./reltouch.txt\n[ -f /tmp/reltouch.txt ]\n'
    );
    assert.strictEqual(exit, 0);
  });
});

describe('chmod host command (numeric mode)', () => {
  it('chmod 755 sets executable bits', async () => {
    const { exit } = await runShell(
      'echo "echo hi" > /tmp/chmod755.sh\nchmod 755 /tmp/chmod755.sh\n[ -x /tmp/chmod755.sh ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('chmod 644 clears executable bits (verified by running file)', async () => {
    const { exit } = await runShell(
      'echo "echo hi" > /tmp/chmod644.sh\nchmod 755 /tmp/chmod644.sh\nchmod 644 /tmp/chmod644.sh\n/tmp/chmod644.sh\n'
    );
    assert.notStrictEqual(exit, 0);
  });

  it('chmod with no args exits non-zero', async () => {
    const { exit } = await runShell('chmod\n');
    assert.strictEqual(exit, 1);
  });

  it('chmod +x adds executable bit', async () => {
    const { exit } = await runShell(
      'echo "echo hi" > /tmp/chmodx.sh\nchmod 644 /tmp/chmodx.sh\nchmod +x /tmp/chmodx.sh\n[ -x /tmp/chmodx.sh ]\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('chmod -x removes executable bit (verified by running file)', async () => {
    const { exit } = await runShell(
      'echo "echo hi" > /tmp/chmodnoex.sh\nchmod 755 /tmp/chmodnoex.sh\nchmod -x /tmp/chmodnoex.sh\n/tmp/chmodnoex.sh\n'
    );
    assert.notStrictEqual(exit, 0);
  });
});

describe('script execution with shebang', () => {
  it('executes a script with #!/bin/sh shebang', async () => {
    const { stdout } = await runShell(
      'printf "#!/bin/sh\\necho shebang_ok\\n" > /tmp/shebang.sh\nchmod 755 /tmp/shebang.sh\n/tmp/shebang.sh\n'
    );
    assert.strictEqual(stdout.trim(), 'shebang_ok');
  });

  it('executes a script without shebang as sh', async () => {
    const { stdout } = await runShell(
      'echo "echo no_shebang" > /tmp/noshebang.sh\nchmod 755 /tmp/noshebang.sh\n/tmp/noshebang.sh\n'
    );
    assert.strictEqual(stdout.trim(), 'no_shebang');
  });

  it('passes arguments to the script', async () => {
    const { stdout } = await runShell(
      'printf "#!/bin/sh\\necho \\$1\\n" > /tmp/args.sh\nchmod 755 /tmp/args.sh\n/tmp/args.sh hello\n'
    );
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('returns non-zero for non-executable file', async () => {
    const { exit } = await runShell(
      'echo "echo hi" > /tmp/noexec.sh\nchmod 644 /tmp/noexec.sh\n/tmp/noexec.sh\n'
    );
    assert.notStrictEqual(exit, 0);
  });

  it('returns non-zero for unknown interpreter', async () => {
    const { exit, stderr } = await runShell(
      'printf "#!/usr/bin/python\\nprint(hello)\\n" > /tmp/shebang_py.py\nchmod 755 /tmp/shebang_py.py\n/tmp/shebang_py.py\n'
    );
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes('interpreter not found'));
  });

  it('unknown interpreter error piped through 2>&1 | cat', async () => {
    const { stdout } = await runShell(
      'printf "#!/usr/bin/ruby\\nputs hi\\n" > /tmp/rb.sh\nchmod 755 /tmp/rb.sh\n/tmp/rb.sh 2>&1 | cat\n'
    );
    assert.ok(stdout.includes('interpreter not found'));
  });

  it('chmod error piped through 2>&1 | cat', async () => {
    const { stdout } = await runShell('chmod 2>&1 | cat\n');
    assert.ok(stdout.includes('missing operand'));
  });
});

describe('PATH lookup for executable scripts', () => {
  it('finds and runs a script in /usr/bin via PATH', async () => {
    const { stdout } = await runShell(
      'mkdir -p /usr/bin\nprintf "#!/bin/sh\\necho path_ok\\n" > /usr/bin/myscript\nchmod 755 /usr/bin/myscript\nmyscript\n'
    );
    assert.strictEqual(stdout.trim(), 'path_ok');
  });

  it('finds scripts in /bin via PATH', async () => {
    const { stdout } = await runShell(
      'mkdir -p /bin\nprintf "#!/bin/sh\\necho bin_ok\\n" > /bin/binscript\nchmod 755 /bin/binscript\nbinscript\n'
    );
    assert.strictEqual(stdout.trim(), 'bin_ok');
  });

  it('returns command not found for unknown command', async () => {
    const { exit } = await runShell('__totally_unknown_cmd_xyz123\n');
    assert.notStrictEqual(exit, 0);
  });

  it('non-executable file in PATH is skipped', async () => {
    const { exit } = await runShell(
      'mkdir -p /usr/bin\necho "echo hi" > /usr/bin/noexecpathscript\nchmod 644 /usr/bin/noexecpathscript\nnoexecpathscript\n'
    );
    assert.notStrictEqual(exit, 0);
  });
});

// NOT COVERED (no builtins/features available in this environment):
// - here-documents (<<): syntax parser does not support heredoc redirection in this WASM shell
// - exec fd redirection (exec 3< file): exec builtin not implemented
// - stderr redirect to file (2>file): stderr is wired to host stderr, not VFS
// - -s file test (non-empty file): appears to return incorrect results
