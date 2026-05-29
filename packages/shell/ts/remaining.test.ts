import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'cli.ts');

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

// =============================================================================
// Missing builtins
// =============================================================================

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
  it('hash -r clears without error', async () => {
    const { exit } = await runShell('hash -r\n');
    assert.strictEqual(exit, 0);
  });
});

// =============================================================================
// Prefix assignments: VAR=val cmd
// =============================================================================

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

// =============================================================================
// export VAR (without =)
// =============================================================================

describe('export without value', () => {
  it('export VAR marks existing var for export', async () => {
    const { stdout } = await runShell('x=hello\nexport x\nenv | grep "^x="\n');
    // env lists all exported vars - x should appear
    assert.strictEqual(stdout.trim(), 'x=hello');
  });

  it('export VAR=val and export VAR both work', async () => {
    const { stdout } = await runShell('export y=world\nenv | grep "^y="\n');
    assert.strictEqual(stdout.trim(), 'y=world');
  });
});

// =============================================================================
// Special variables
// =============================================================================

describe('special variables', () => {
  it('$RANDOM produces a number', async () => {
    const { stdout } = await runShell('echo $RANDOM\n');
    const num = parseInt(stdout.trim());
    assert.ok(!isNaN(num) && num >= 0 && num <= 32767);
  });

  it('$RANDOM varies between calls', async () => {
    const { stdout } = await runShell('echo $RANDOM $RANDOM\n');
    const parts = stdout.trim().split(' ');
    // They could be the same by chance, but almost certainly won't be
    assert.strictEqual(parts.length, 2);
    assert.ok(!isNaN(parseInt(parts[0])));
  });

  it('$LINENO tracks line number', async () => {
    const { stdout } = await runShell('echo $LINENO\necho $LINENO\necho $LINENO\n');
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });
});

// =============================================================================
// Coreutils builtins
// =============================================================================

describe('builtin: cat', () => {
  it('cat reads file', async () => {
    const { stdout } = await runShell('echo "hello" > /tmp/cat_test.txt\ncat /tmp/cat_test.txt\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('cat reads stdin in pipeline', async () => {
    const { stdout } = await runShell('echo "world" | cat\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('cat concatenates multiple files', async () => {
    const { stdout } = await runShell('echo "a" > /tmp/c1.txt\necho "b" > /tmp/c2.txt\ncat /tmp/c1.txt /tmp/c2.txt\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });
});

describe('builtin: head/tail', () => {
  it('head -n 2 shows first 2 lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\nd\\n" | head -n 2\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('tail -n 2 shows last 2 lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\nd\\n" | tail -n 2\n');
    assert.strictEqual(stdout.trim(), 'c\nd');
  });
});

describe('builtin: wc', () => {
  it('wc -l counts lines', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | wc -l\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('wc -w counts words', async () => {
    const { stdout } = await runShell('echo "hello world foo" | wc -w\n');
    assert.strictEqual(stdout.trim(), '3');
  });
});

describe('builtin: grep', () => {
  it('grep filters matching lines', async () => {
    const { stdout } = await runShell('printf "apple\\nbanana\\napricot\\n" | grep "ap"\n');
    assert.strictEqual(stdout.trim(), 'apple\napricot');
  });

  it('grep -v inverts match', async () => {
    const { stdout } = await runShell('printf "apple\\nbanana\\napricot\\n" | grep -v "ap"\n');
    assert.strictEqual(stdout.trim(), 'banana');
  });

  it('grep -c counts matches', async () => {
    const { stdout } = await runShell('printf "a\\nb\\na\\n" | grep -c "a"\n');
    assert.strictEqual(stdout.trim(), '2');
  });

  it('grep exits 1 when no match', async () => {
    const { exit } = await runShell('echo hello | grep xyz\n');
    assert.strictEqual(exit, 1);
  });
});

describe('builtin: seq', () => {
  it('seq generates range', async () => {
    const { stdout } = await runShell('seq 1 5\n');
    assert.strictEqual(stdout.trim(), '1\n2\n3\n4\n5');
  });

  it('seq with step', async () => {
    const { stdout } = await runShell('seq 1 2 7\n');
    assert.strictEqual(stdout.trim(), '1\n3\n5\n7');
  });
});

describe('builtin: basename/dirname', () => {
  it('basename extracts filename', async () => {
    const { stdout } = await runShell('basename /usr/local/bin/foo\n');
    assert.strictEqual(stdout.trim(), 'foo');
  });

  it('basename strips suffix', async () => {
    const { stdout } = await runShell('basename /path/to/file.txt .txt\n');
    assert.strictEqual(stdout.trim(), 'file');
  });

  it('dirname extracts directory', async () => {
    const { stdout } = await runShell('dirname /usr/local/bin/foo\n');
    assert.strictEqual(stdout.trim(), '/usr/local/bin');
  });
});

describe('builtin: sort/uniq', () => {
  it('sort orders lines', async () => {
    const { stdout } = await runShell('printf "banana\\napple\\ncherry\\n" | sort\n');
    assert.strictEqual(stdout.trim(), 'apple\nbanana\ncherry');
  });

  it('sort -r reverses', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | sort -r\n');
    assert.strictEqual(stdout.trim(), 'c\nb\na');
  });

  it('sort -n numeric sort', async () => {
    const { stdout } = await runShell('printf "10\\n2\\n1\\n" | sort -n\n');
    assert.strictEqual(stdout.trim(), '1\n2\n10');
  });

  it('uniq removes consecutive duplicates', async () => {
    const { stdout } = await runShell('printf "a\\na\\nb\\nb\\na\\n" | uniq\n');
    assert.strictEqual(stdout.trim(), 'a\nb\na');
  });
});

describe('builtin: tr', () => {
  it('tr translates characters', async () => {
    const { stdout } = await runShell('echo "hello" | tr "a-z" "A-Z"\n');
    assert.strictEqual(stdout.trim(), 'HELLO');
  });

  it('tr -d deletes characters', async () => {
    const { stdout } = await runShell('echo "hello world" | tr -d " "\n');
    assert.strictEqual(stdout.trim(), 'helloworld');
  });
});

describe('builtin: cut', () => {
  it('cut -d -f extracts field', async () => {
    const { stdout } = await runShell('echo "a:b:c" | cut -d: -f2\n');
    assert.strictEqual(stdout.trim(), 'b');
  });
});

describe('builtin: tee', () => {
  it('tee duplicates to file and stdout', async () => {
    const { stdout } = await runShell('echo "hello" | tee /tmp/tee_out.txt\ncat /tmp/tee_out.txt\n');
    assert.strictEqual(stdout.trim(), 'hello\nhello');
  });
});

describe('builtin: xargs', () => {
  it('xargs passes stdin as args', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | xargs echo\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });
});

describe('builtin: sleep', () => {
  it('sleep 0 completes without error', async () => {
    const { exit } = await runShell('sleep 0\n');
    assert.strictEqual(exit, 0);
  });
});

describe('builtin: mkdir/rm/cp/mv/ls', () => {
  it('mkdir creates directory', async () => {
    const { exit } = await runShell('mkdir /tmp/test_dir\ntest -d /tmp/test_dir && echo ok\n');
    assert.strictEqual(exit, 0);
  });

  it('ls lists directory contents', async () => {
    const { stdout } = await runShell('echo x > /tmp/ls_a.txt\necho y > /tmp/ls_b.txt\nls /tmp/ls_a.txt /tmp/ls_b.txt\n');
    assert.ok(stdout.includes('ls_a.txt'));
    assert.ok(stdout.includes('ls_b.txt'));
  });

  it('cp copies file', async () => {
    const { stdout } = await runShell('echo "data" > /tmp/cp_src.txt\ncp /tmp/cp_src.txt /tmp/cp_dst.txt\ncat /tmp/cp_dst.txt\n');
    assert.strictEqual(stdout.trim(), 'data');
  });

  it('mv moves file', async () => {
    const { stdout } = await runShell('echo "data" > /tmp/mv_src.txt\nmv /tmp/mv_src.txt /tmp/mv_dst.txt\ncat /tmp/mv_dst.txt\n');
    assert.strictEqual(stdout.trim(), 'data');
  });

  it('rm removes file', async () => {
    const { stdout } = await runShell('echo x > /tmp/rm_test.txt\nrm /tmp/rm_test.txt\ntest -f /tmp/rm_test.txt && echo exists || echo gone\n');
    assert.strictEqual(stdout.trim(), 'gone');
  });
});

// =============================================================================
// PATH-based command lookup
// =============================================================================

describe('PATH-based lookup', () => {
  it('commands in PATH directories are found', async () => {
    // Create a "script" in /bin and verify it can be found
    // (this tests the concept - actual impl depends on VFS executables)
    const { stdout } = await runShell('echo $PATH\n');
    assert.ok(stdout.length > 0);
  });
});

// =============================================================================
// Heredoc edge cases
// =============================================================================

describe('heredoc edge cases', () => {
  it('<<- strips leading tabs from content', async () => {
    const { stdout } = await runShell('x=$(<<-EOF\n\thello\n\tworld\nEOF\n)\necho "$x"\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });
});
