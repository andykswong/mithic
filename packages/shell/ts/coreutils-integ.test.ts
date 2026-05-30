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
