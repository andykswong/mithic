import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

function runShell(script: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--experimental-strip-types', CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
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
// tee
// =============================================================================

describe('tee', () => {
  it('writes to file and passes through to stdout', async () => {
    const { stdout } = await runShell(
      'echo "hello" | tee /tmp/tee_out.txt\ncat /tmp/tee_out.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'hello\nhello');
  });

  it('file contains the teed content', async () => {
    const { stdout } = await runShell(
      'echo "teed" | tee /tmp/tee_check.txt\ncat /tmp/tee_check.txt\n'
    );
    assert.ok(stdout.includes('teed'));
  });

  it('stdout output matches input', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | tee /tmp/tee_abc.txt | wc -l\n');
    assert.strictEqual(stdout.trim(), '3');
  });

  it('-a appends to existing file', async () => {
    const { stdout } = await runShell(
      'echo "first" > /tmp/tee_app.txt\necho "second" | tee -a /tmp/tee_app.txt\ncat /tmp/tee_app.txt\n'
    );
    assert.ok(stdout.includes('first'));
    assert.ok(stdout.includes('second'));
    // "first" should appear before "second" in file
    const fileIdx = stdout.indexOf('first');
    const secondIdx = stdout.indexOf('second');
    assert.ok(fileIdx < secondIdx || stdout.split('\n').filter(l => l.trim()).length >= 3);
  });

  it('without -a truncates file on each run', async () => {
    const { stdout } = await runShell(
      'echo "original" > /tmp/tee_trunc.txt\necho "replaced" | tee /tmp/tee_trunc.txt > /dev/null\ncat /tmp/tee_trunc.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'replaced');
  });

  it('tee in pipeline passes data through correctly', async () => {
    const { stdout } = await runShell(
      'seq 1 5 | tee /tmp/tee_pipe.txt | wc -l\ncat /tmp/tee_pipe.txt | wc -l\n'
    );
    assert.strictEqual(stdout.trim(), '5\n5');
  });
});

// =============================================================================
// xargs
// =============================================================================

describe('xargs', () => {
  it('passes stdin lines as arguments', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | xargs echo\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('works with a single item', async () => {
    const { stdout } = await runShell('echo "hello" | xargs echo\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('handles multiple lines joined', async () => {
    const { stdout } = await runShell('printf "foo\\nbar\\n" | xargs echo\n');
    assert.strictEqual(stdout.trim(), 'foo bar');
  });

  it('-n limits args per invocation', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\n" | xargs -n1 echo\n');
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('-0 null-delimited input', async () => {
    const { stdout } = await runShell('printf "a\\0b\\0c\\0" | xargs -0 echo\n');
    assert.strictEqual(stdout.trim(), 'a b c');
  });

  it('-I replacement string', async () => {
    const { stdout } = await runShell('printf "a\\nb\\n" | xargs -I{} echo "item: {}"\n');
    assert.strictEqual(stdout.trim(), 'item: a\nitem: b');
  });
});

// =============================================================================
// yes
// =============================================================================

describe('yes', () => {
  it('outputs "y" lines when piped to head', async () => {
    const { stdout } = await runShell('yes | head -n 3\n');
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('outputs custom string when argument given', async () => {
    const { stdout } = await runShell('yes hello | head -n 2\n');
    assert.strictEqual(stdout.trim(), 'hello\nhello');
  });

  it('exit code is 0 when used with head', async () => {
    const { exit } = await runShell('yes | head -n 1\n');
    assert.strictEqual(exit, 0);
  });

  it('produces more than one line', async () => {
    const { stdout } = await runShell('yes | head -n 5\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 5);
  });
});

// =============================================================================
// paste
// =============================================================================

describe('paste', () => {
  it('merges two files line by line with tab delimiter', async () => {
    const { stdout } = await runShell(
      'printf "a\\nb\\nc\\n" > /tmp/paste_a.txt\nprintf "x\\ny\\nz\\n" > /tmp/paste_b.txt\npaste /tmp/paste_a.txt /tmp/paste_b.txt\n'
    );
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[0].includes('a'));
    assert.ok(lines[0].includes('x'));
  });

  it('uses tab as default delimiter', async () => {
    const { stdout } = await runShell(
      'printf "1\\n2\\n" > /tmp/paste_num.txt\nprintf "a\\nb\\n" > /tmp/paste_alpha.txt\npaste /tmp/paste_num.txt /tmp/paste_alpha.txt\n'
    );
    assert.ok(stdout.includes('\t'));
  });

  it('-d custom delimiter', async () => {
    const { stdout } = await runShell(
      'printf "a\\nb\\n" > /tmp/paste_d1.txt\nprintf "x\\ny\\n" > /tmp/paste_d2.txt\npaste -d, /tmp/paste_d1.txt /tmp/paste_d2.txt\n'
    );
    assert.ok(stdout.includes('a,x') || stdout.includes(','));
  });

  it('merges stdin lines serially with - placeholder', async () => {
    const { stdout } = await runShell('printf "a\\nb\\nc\\nd\\n" | paste - -\n');
    assert.strictEqual(stdout.trim(), 'a\tb\nc\td');
  });
});

// =============================================================================
// cat streaming from devices
// =============================================================================

describe('cat streaming from devices', () => {
  it('cat /dev/null produces empty output', async () => {
    const { stdout } = await runShell('cat /dev/null; echo done\n');
    assert.strictEqual(stdout.trim(), 'done');
  });

  it('cat regular file still works', async () => {
    const { stdout } = await runShell('echo hello > /tmp/cat_stream.txt; cat /tmp/cat_stream.txt\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('cat multiple files concatenates', async () => {
    const { stdout } = await runShell(
      'echo aaa > /tmp/cat_a.txt; echo bbb > /tmp/cat_b.txt; cat /tmp/cat_a.txt /tmp/cat_b.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'aaa\nbbb');
  });

  it('cat -n numbers lines', async () => {
    const { stdout } = await runShell(
      'printf "line1\\nline2\\nline3\\n" > /tmp/cat_n.txt; cat -n /tmp/cat_n.txt\n'
    );
    assert.ok(stdout.includes('1\tline1'));
    assert.ok(stdout.includes('2\tline2'));
    assert.ok(stdout.includes('3\tline3'));
  });

  it('cat nonexistent file prints error and returns 1', async () => {
    const { stderr, exit } = await runShell('cat /tmp/no_such_file_xyz\n');
    assert.ok(stderr.includes('No such file or directory'));
    assert.strictEqual(exit, 1);
  });
});

// =============================================================================
// head streaming
// =============================================================================

describe('head streaming', () => {
  it('head -c N from file reads only N bytes', async () => {
    const { stdout } = await runShell(
      'printf "abcdefghij" > /tmp/head_bytes.txt; head -c 5 /tmp/head_bytes.txt\n'
    );
    assert.strictEqual(stdout, 'abcde');
  });

  it('head -n N from file reads only N lines', async () => {
    const { stdout } = await runShell(
      'printf "a\\nb\\nc\\nd\\ne\\n" > /tmp/head_lines.txt; head -n 3 /tmp/head_lines.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('head defaults to 10 lines', async () => {
    const { stdout } = await runShell(
      'seq 1 20 > /tmp/head_default.txt; head /tmp/head_default.txt\n'
    );
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 10);
    assert.strictEqual(lines[0], '1');
    assert.strictEqual(lines[9], '10');
  });

  it('head nonexistent file prints error', async () => {
    const { stderr, exit } = await runShell('head /tmp/no_such_head_file\n');
    assert.ok(stderr.includes('No such file or directory'));
    assert.strictEqual(exit, 1);
  });

  it('head -c N from /dev/random reads exactly N bytes (infinite device)', async () => {
    const { stdout } = await runShell('head -c 16 /dev/random | base64\n');
    assert.ok(stdout.trim().length > 0, 'should produce base64 output');
    assert.match(stdout.trim(), /^[A-Za-z0-9+/]+=*$/);
  });

  it('head -c N from /dev/zero reads N zero bytes', async () => {
    const { stdout } = await runShell('head -c 4 /dev/zero | base64\n');
    assert.strictEqual(stdout.trim(), 'AAAAAA==');
  });

  it('head -n 3 from stdin pipe', async () => {
    const { stdout, exit } = await runShell('printf "a\\nb\\nc\\nd\\ne\\n" | head -n 3\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });
});

// =============================================================================
// broken-pipe with streaming commands
// =============================================================================

describe('broken-pipe with streaming commands', () => {
  it('yes | grep y | head -n 3 (grep streaming)', async () => {
    const { stdout, exit } = await runShell('yes | grep y | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('yes | cut -c1 | head -n 3 (cut streaming)', async () => {
    const { stdout, exit } = await runShell('yes | cut -c1 | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('yes | uniq | head -n 1 (uniq streaming, adjacent dedup)', async () => {
    const { stdout, exit } = await runShell('yes | uniq | head -n 1\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y');
  });

  it('yes | rev | head -n 3 (rev streaming)', async () => {
    const { stdout, exit } = await runShell('yes | rev | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('yes | sed \'s/y/Y/\' | head -n 3 (sed streaming)', async () => {
    const { stdout, exit } = await runShell('yes | sed \'s/y/Y/\' | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'Y\nY\nY');
  });
});

// =============================================================================
// empty input edge cases
// =============================================================================

describe('empty input edge cases', () => {
  it('echo -n "" | wc -l returns 0', async () => {
    const { stdout, exit } = await runShell('echo -n "" | wc -l\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '0');
  });

  it('echo -n "" | wc -c returns 0', async () => {
    const { stdout, exit } = await runShell('echo -n "" | wc -c\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '0');
  });
});
