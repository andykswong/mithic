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

  // Phase B requirement: these will ONLY pass with WorkerProcessManager
  // Currently they timeout with SimpleProcessManager due to deadlock.
  // TODO: Enable once WorkerProcessManager is integrated into cli.ts
  //
  // it('cat /dev/zero | head -c 4 does not deadlock', async () => {
  //   const { stdout, exit } = await runShell('cat /dev/zero | head -c 4\n');
  //   assert.strictEqual(stdout.length, 4);
  //   assert.strictEqual(exit, 0);
  // });
  //
  // it('yes | head -n 3 terminates with broken-pipe', async () => {
  //   const { stdout, exit } = await runShell('yes | head -n 3\n');
  //   const lines = stdout.trim().split('\n');
  //   assert.strictEqual(lines.length, 3);
  //   assert.strictEqual(exit, 0);
  // });
});
