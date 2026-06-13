import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

async function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
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
    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('self-invocation: sh -c from within shell', () => {
  it('sh -c "echo hello" outputs hello', async () => {
    const { stdout } = await runShell('sh -c "echo hello"\n');
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('sh -c returns exit code via $?', async () => {
    const { stdout } = await runShell('sh -c "exit 1"\necho $?\n');
    assert.strictEqual(stdout.trim(), '1');
  });

  it('sh -c with variable', async () => {
    const { stdout } = await runShell('sh -c "echo from_child"\n');
    assert.strictEqual(stdout.trim(), 'from_child');
  });

  it('sh script.sh executes script file', async () => {
    const { stdout } = await runShell('echo "echo from_script" > /tmp/test_invoke.sh\nsh /tmp/test_invoke.sh\n');
    assert.strictEqual(stdout.trim(), 'from_script');
  });

  it('nested: sh -c "sh -c \'echo deep\'"', async () => {
    const { stdout } = await runShell('sh -c "sh -c \'echo deep\'"\n');
    assert.strictEqual(stdout.trim(), 'deep');
  });
});

describe('PATH variable', () => {
  it('PATH is set', async () => {
    const { stdout } = await runShell('echo $PATH\n');
    assert.ok(stdout.trim().length > 0);
  });
});
