import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runShell(script: string, mode: 'worker' | 'async'): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const args = mode === 'async' ? [CLI, '--async'] : [CLI];
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
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

for (const mode of ['worker', 'async'] as const) {
  describe(`jq smoke (${mode} mode)`, () => {

    it('identity filter', async () => {
      const { stdout, exit } = await runShell(`echo '{"a":1}' | jq '.'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '{\n  "a": 1\n}');
    });

    it('field access', async () => {
      const { stdout, exit } = await runShell(`echo '{"a":1,"b":2}' | jq '.a'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '1');
    });

    it('array iterator', async () => {
      const { stdout, exit } = await runShell(`echo '[1,2,3]' | jq '.[]'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '1\n2\n3');
    });

    it('pipe and select', async () => {
      const { stdout, exit } = await runShell(`echo '[1,2,3,4,5]' | jq '[.[] | select(. > 3)]'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '[\n  4,\n  5\n]');
    });

    it('compact output -c', async () => {
      const { stdout, exit } = await runShell(`echo '{"a": 1}' | jq -c '.'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '{"a":1}');
    });

    it('raw output -r', async () => {
      const { stdout, exit } = await runShell(`echo '"hello"' | jq -r '.'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), 'hello');
    });

    it('sort_by', async () => {
      const { stdout, exit } = await runShell(`echo '[{"a":3},{"a":1},{"a":2}]' | jq -c 'sort_by(.a)'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '[{"a":1},{"a":2},{"a":3}]');
    });

    it('reduce', async () => {
      const { stdout, exit } = await runShell(`echo '[1,2,3,4,5]' | jq 'reduce .[] as $x (0; . + $x)'\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), '15');
    });

  });
}
