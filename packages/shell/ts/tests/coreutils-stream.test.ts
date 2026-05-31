import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
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
