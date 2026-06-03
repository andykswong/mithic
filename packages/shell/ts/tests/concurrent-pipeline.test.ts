import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli.ts');

async function runShell(script: string, timeoutMs = 5000): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
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
    child.on('error', reject);
    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('concurrent pipeline execution (Phase B)', () => {
  it('echo | tr pipeline works (finite data)', async () => {
    const { stdout, exit } = await runShell('echo hello | tr "a-z" "A-Z"\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'HELLO');
  });

  it('printf | sort | head: three-stage finite pipeline', async () => {
    const { stdout, exit } = await runShell('printf "banana\\napple\\ncherry\\n" | sort | head -n 1\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'apple');
  });

  it('pipeline exit code reflects last command', async () => {
    const { exit } = await runShell('true | false\n');
    assert.strictEqual(exit, 1);
  });

  it('yes | head -n 3 terminates with broken-pipe', async () => {
    const { stdout, exit } = await runShell('yes | head -n 3\n');
    const lines = stdout.trim().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(exit, 0);
  });

  it('cat /dev/zero | head -c 4 does not deadlock', async () => {
    const { stdout, exit } = await runShell('cat /dev/zero | head -c 4 | wc -c\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4');
  });

  it('yes | head -c 4 terminates (infinite producer, byte limit)', async () => {
    const { stdout, exit } = await runShell('yes | head -c 4 | wc -c\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4');
  });

  it('yes | tr y Y | head -n 3 (infinite → transform → finite)', async () => {
    const { stdout, exit } = await runShell('yes | tr y Y | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'Y\nY\nY');
  });

  it('yes | tee /dev/null | head -n 3 (infinite → tee → finite)', async () => {
    const { stdout, exit } = await runShell('yes | tee /dev/null | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('yes | cat | head -n 3 (infinite → passthrough → finite)', async () => {
    const { stdout, exit } = await runShell('yes | cat | head -n 3\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'y\ny\ny');
  });

  it('seq 1 10000 | cat | wc -l (large finite through pipeline)', async () => {
    const { stdout, exit } = await runShell('seq 1 10000 | cat | wc -l\n', 10000);
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '10000');
  });
});
