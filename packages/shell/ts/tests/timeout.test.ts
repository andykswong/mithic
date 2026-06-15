import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

async function runShell(script: string, timeoutMs = 10000): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
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

async function runAsync(script: string, timeoutMs = 10000): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', CLI, '--async'], {
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

describe('timeout command (worker mode)', () => {
  it('timeout with fast command exits normally', async () => {
    const { stdout, exit } = await runShell('timeout 5 sh -c "echo hello"\n');
    assert.strictEqual(stdout.trim(), 'hello');
    assert.strictEqual(exit, 0);
  });

  it('timeout kills slow command and exits 124', async () => {
    const { stdout } = await runShell('timeout 0.5 sleep 10\necho $?\n');
    assert.strictEqual(stdout.trim(), '124');
  });

  it('timeout with nonexistent command exits 127', async () => {
    const { stdout } = await runShell('timeout 1 nonexistent_cmd_xyz\necho $?\n');
    assert.strictEqual(stdout.trim(), '127');
  });

  it('timeout with no args exits 125', async () => {
    const { stdout } = await runShell('timeout\necho $?\n');
    assert.strictEqual(stdout.trim(), '125');
  });

  it('timeout with invalid duration exits 125', async () => {
    const { stdout } = await runShell('timeout abc cat /dev/null\necho $?\n');
    assert.strictEqual(stdout.trim(), '125');
  });

  it('timeout with inline worker child does not deadlock', async () => {
    const { stdout, exit } = await runShell('timeout 5 chmod 755 /tmp\necho done\n');
    assert.strictEqual(stdout.trim(), 'done');
    assert.strictEqual(exit, 0);
  });
});

describe('timeout command (async mode)', () => {
  it('timeout with fast command exits normally', async () => {
    const { stdout, exit } = await runAsync('timeout 5 sh -c "echo hello"\n');
    assert.strictEqual(stdout.trim(), 'hello');
    assert.strictEqual(exit, 0);
  });

  it('timeout kills slow command and exits 124', async () => {
    const { stdout } = await runAsync('timeout 0.5 sleep 10\necho $?\n');
    assert.strictEqual(stdout.trim(), '124');
  });

  it('timeout with nonexistent command exits 127', async () => {
    const { stdout } = await runAsync('timeout 1 nonexistent_cmd_xyz\necho $?\n');
    assert.strictEqual(stdout.trim(), '127');
  });

  it('timeout with no args exits 125', async () => {
    const { stdout } = await runAsync('timeout\necho $?\n');
    assert.strictEqual(stdout.trim(), '125');
  });

  it('timeout with invalid duration exits 125', async () => {
    const { stdout } = await runAsync('timeout abc cat /dev/null\necho $?\n');
    assert.strictEqual(stdout.trim(), '125');
  });
});

describe('read -t (worker mode)', () => {
  it('read -t with pipe input succeeds', async () => {
    const { stdout } = await runShell('echo hello | read -t 1 var\necho $var\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});

describe('read -t (async mode)', () => {
  it('read -t with pipe input succeeds', async () => {
    const { stdout } = await runAsync('echo hello | read -t 1 var\necho $var\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });
});
