/**
 * Async mode integration tests.
 * Verifies that the shell works correctly with SimpleProcessManager + JSPI/asyncify
 * (no Workers, no SharedArrayBuffer).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

async function runAsync(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', CLI, '--async'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
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

describe('async mode: basic commands', () => {
  it('echo produces output', async () => {
    const { stdout, exit } = await runAsync('echo hello\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('variable expansion works', async () => {
    const { stdout } = await runAsync('x=world\necho "hello $x"\n');
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('exit code propagates', async () => {
    const { exit } = await runAsync('false\n');
    assert.strictEqual(exit, 1);
  });

  it('arithmetic expansion works', async () => {
    const { stdout } = await runAsync('echo $((2 + 3))\n');
    assert.strictEqual(stdout.trim(), '5');
  });
});

describe('async mode: pipelines', () => {
  it('simple two-stage pipe', async () => {
    const { stdout, exit } = await runAsync('echo hello | tr a-z A-Z\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'HELLO');
  });

  it('three-stage pipe', async () => {
    const { stdout, exit } = await runAsync('echo "hello world" | tr a-z A-Z | cut -d" " -f1\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'HELLO');
  });

  it('infinite producer with finite consumer (cat /dev/zero | head)', async () => {
    const { stdout, exit } = await runAsync('cat /dev/zero | head -c 4 | wc -c\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4');
  });

  it('cat /dev/urandom | head -c N terminates', async () => {
    const { stdout, exit } = await runAsync('cat /dev/urandom | head -c 8 | wc -c\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '8');
  });

  it('cat /dev/urandom | base64 | head terminates', async () => {
    const { stdout, exit } = await runAsync('cat /dev/urandom | base64 | head -c 4 | wc -c\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '4');
  });

  it('sort pipeline works', async () => {
    const { stdout } = await runAsync('printf "b\\na\\nc\\n" | sort\n');
    assert.strictEqual(stdout.trim(), 'a\nb\nc');
  });

  it('grep in pipeline', async () => {
    const { stdout } = await runAsync('printf "foo\\nbar\\nbaz\\n" | grep ba\n');
    assert.strictEqual(stdout.trim(), 'bar\nbaz');
  });
});

describe('async mode: filesystem', () => {
  it('write and read file', async () => {
    const { stdout } = await runAsync('echo content > /tmp/test.txt\ncat /tmp/test.txt\n');
    assert.strictEqual(stdout.trim(), 'content');
  });

  it('ls lists files', async () => {
    const { stdout } = await runAsync('echo x > /tmp/ls_test.txt\nls /tmp/ls_test.txt\n');
    assert.ok(stdout.includes('ls_test.txt'));
  });
});

describe('async mode: subshell and scripts', () => {
  it('-c flag executes command string', async () => {
    const { stdout } = await runAsync('bash -c "echo from_subshell"\n');
    assert.strictEqual(stdout.trim(), 'from_subshell');
  });

  it('command substitution works', async () => {
    const { stdout } = await runAsync('x=$(echo hello)\necho $x\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('for loop works', async () => {
    const { stdout } = await runAsync('for i in 1 2 3; do echo $i; done\n');
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });
});

describe('async mode: exit handling', () => {
  it('non-zero command does not crash the shell', async () => {
    const { stdout, exit } = await runAsync('ls /nonexistent\necho alive\n');
    assert.ok(stdout.includes('alive'), 'shell should continue after failed command');
    assert.strictEqual(exit, 0);
  });

  it('exit 0 after error returns 0', async () => {
    const { stdout, exit } = await runAsync('false\necho still\nexit 0\n');
    assert.ok(stdout.includes('still'));
    assert.strictEqual(exit, 0);
  });

  it('false as last command exits 1', async () => {
    const { exit } = await runAsync('false\n');
    assert.strictEqual(exit, 1);
  });

  it('successful script exits 0', async () => {
    const { stdout, exit } = await runAsync('echo ok\ntrue\n');
    assert.strictEqual(stdout.trim(), 'ok');
    assert.strictEqual(exit, 0);
  });
});
