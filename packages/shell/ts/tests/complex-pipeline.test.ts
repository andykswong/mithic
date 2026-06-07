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
// Multi-stage pipelines
// =============================================================================

describe('multi-stage pipelines', () => {
  it('seq 10 | sort -n -r | head -n 3 — reverse-sorted first 3 numbers', async () => {
    const { stdout } = await runShell('seq 10 | sort -n -r | head -n 3\n');
    assert.strictEqual(stdout.trim(), '10\n9\n8');
  });

  it('echo "hello world" | sed "s/ /\\n/g" | sort | uniq — word split, sort, dedup', async () => {
    const { stdout } = await runShell('echo "hello world" | sed "s/ /\\n/g" | sort | uniq\n');
    assert.strictEqual(stdout.trim(), 'hello\nworld');
  });

  it('seq 20 | grep -E "^1" | wc -l — count numbers starting with 1', async () => {
    // Numbers starting with 1: 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 = 11
    const { stdout } = await runShell('seq 20 | grep -E "^1" | wc -l\n');
    assert.strictEqual(stdout.trim(), '11');
  });

  it('echo "a:b:c:d" | cut -d: -f2,4 — field extraction', async () => {
    const { stdout } = await runShell('echo "a:b:c:d" | cut -d: -f2,4\n');
    assert.strictEqual(stdout.trim(), 'b:d');
  });

  it('echo "hello" | rev — reverse string', async () => {
    const { stdout } = await runShell('echo "hello" | rev\n');
    assert.strictEqual(stdout.trim(), 'olleh');
  });

  it('seq 5 | tail -n 3 | sort -n -r | head -n 2 — multi-stage filter', async () => {
    const { stdout } = await runShell('seq 5 | tail -n 3 | sort -n -r | head -n 2\n');
    assert.strictEqual(stdout.trim(), '5\n4');
  });
});

// =============================================================================
// /dev device files in pipelines
// =============================================================================

describe('/dev device files in pipelines', () => {
  it('echo hello | cat /dev/stdin — /dev/stdin reads from pipe', async () => {
    const { stdout } = await runShell('echo hello | cat /dev/stdin\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('echo world > /dev/stdout — /dev/stdout writes to terminal stdout', async () => {
    const { stdout } = await runShell('echo world > /dev/stdout\n');
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('cat /dev/urandom | head -c 16 | base64 — random bytes through base64', async () => {
    const { stdout } = await runShell('cat /dev/urandom | head -c 16 | base64\n', 10000);
    assert.ok(stdout.trim().length > 0, 'should produce base64 output');
    assert.match(stdout.trim(), /^[A-Za-z0-9+/]+=*$/);
  });

  it('cat /dev/zero | head -c 8 | base64 — zero bytes through base64', async () => {
    const { stdout } = await runShell('cat /dev/zero | head -c 8 | base64\n', 10000);
    assert.strictEqual(stdout.trim(), 'AAAAAAAAAAA=');
  });
});

// =============================================================================
// Redirects combined with pipes
// =============================================================================

describe('redirects combined with pipes', () => {
  it('echo "data" > /tmp/rtest.txt && cat /tmp/rtest.txt | rev — redirect to file then pipe', async () => {
    const { stdout } = await runShell('echo "data" > /tmp/rtest.txt && cat /tmp/rtest.txt | rev\n');
    assert.strictEqual(stdout.trim(), 'atad');
  });

  it('file redirect into pipe via < and | wc -l', async () => {
    const { stdout } = await runShell(
      'printf "line1\\nline2\\n" > /tmp/r.txt\ncat < /tmp/r.txt | wc -l\n'
    );
    assert.strictEqual(stdout.trim(), '2');
  });

  it('seq 5 > /tmp/seq.txt && tail -n 2 /tmp/seq.txt — file redirect then read back', async () => {
    const { stdout } = await runShell('seq 5 > /tmp/seq.txt && tail -n 2 /tmp/seq.txt\n');
    assert.strictEqual(stdout.trim(), '4\n5');
  });

  it('echo "hello" | tee /tmp/tee.txt | rev — tee in pipeline with rev', async () => {
    const { stdout } = await runShell(
      'echo "hello" | tee /tmp/tee.txt | rev\ncat /tmp/tee.txt\n'
    );
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines[0], 'olleh');
    assert.strictEqual(lines[1], 'hello');
  });
});

// =============================================================================
// Infinite producers with pipeline termination
// =============================================================================

describe('infinite producers with pipeline termination', () => {
  it('yes | head -n 3 — should terminate after 3 lines', async () => {
    const { stdout, exit } = await runShell('yes | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('cat /dev/zero | head -c 4 | wc -c — should count 4 bytes', async () => {
    const { stdout, exit } = await runShell('cat /dev/zero | head -c 4 | wc -c\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4');
  });

  it('seq 1000000 | head -n 5 — large producer terminates early', async () => {
    const { stdout, exit } = await runShell('seq 1000000 | head -n 5\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2\n3\n4\n5');
  });
});

// =============================================================================
// Here-strings and multi-command
// =============================================================================

describe('here-strings and multi-command', () => {
  it('cat <<< "heredoc test" — here-string', async () => {
    const { stdout } = await runShell('cat <<< "heredoc test"\n');
    assert.strictEqual(stdout.trim(), 'heredoc test');
  });

  it('echo a && echo b — sequential execution', async () => {
    const { stdout } = await runShell('echo a && echo b\n');
    assert.strictEqual(stdout.trim(), 'a\nb');
  });

  it('false || echo fallback — OR chain', async () => {
    const { stdout } = await runShell('false || echo fallback\n');
    assert.strictEqual(stdout.trim(), 'fallback');
  });
});

// =============================================================================
// Subshell and command substitution in pipelines
// =============================================================================

describe('subshell and command substitution in pipelines', () => {
  it('echo "count: $(seq 3 | wc -l)" — command substitution with pipe', async () => {
    const { stdout } = await runShell('echo "count: $(seq 3 | wc -l)"\n');
    assert.strictEqual(stdout.trim(), 'count: 3');
  });

  it('(echo a; echo b; echo c) | sort -r — subshell output into pipe', async () => {
    const { stdout } = await runShell('(echo a; echo b; echo c) | sort -r\n');
    assert.strictEqual(stdout.trim(), 'c\nb\na');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('pipeline edge cases', () => {
  it('echo "" | wc -c — empty string still has newline', async () => {
    // echo "" outputs a newline, so 1 byte
    const { stdout } = await runShell('echo "" | wc -c\n');
    assert.strictEqual(stdout.trim(), '1');
  });

  it('printf "no newline" | wc -c — 10 chars, no trailing newline', async () => {
    const { stdout } = await runShell('printf "no newline" | wc -c\n');
    assert.strictEqual(stdout.trim(), '10');
  });

  it('echo "hello" | grep -c hello — grep count mode', async () => {
    const { stdout } = await runShell('echo "hello" | grep -c hello\n');
    assert.strictEqual(stdout.trim(), '1');
  });

  it('echo "a b c" | awk "{print \\$2}" — awk field extraction', async () => {
    const { stdout } = await runShell('echo "a b c" | awk \'{print $2}\'\n');
    assert.strictEqual(stdout.trim(), 'b');
  });
});
