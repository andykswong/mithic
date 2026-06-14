import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runShellMode(script: string, mode: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const args = mode === 'async' ? [CLI, '--async'] : [CLI];
    const child = spawn('node', args, {
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

for (const mode of ['worker', 'async']) {
  describe(`shopt (${mode} mode)`, () => {
    const runShell = (script: string) => runShellMode(script, mode);

    it('shopt with no args lists options', async () => {
      const { stdout, exit } = await runShell('shopt\n');
      assert.strictEqual(exit, 0);
      assert.ok(stdout.includes('extglob'), 'should list extglob');
      assert.ok(stdout.includes('globstar'), 'should list globstar');
      assert.ok(stdout.includes('nullglob'), 'should list nullglob');
      assert.ok(stdout.includes('dotglob'), 'should list dotglob');
    });

    it('shopt -s extglob enables extglob', async () => {
      const { stdout, exit } = await runShell('shopt -s extglob\nshopt extglob\n');
      assert.strictEqual(exit, 0);
      assert.ok(stdout.includes('on'), 'extglob should be on');
    });

    it('shopt -u extglob disables it', async () => {
      const { stdout, exit } = await runShell('shopt -s extglob\nshopt -u extglob\nshopt extglob\n');
      assert.strictEqual(exit, 1, 'shopt extglob for disabled option exits 1');
      assert.ok(stdout.includes('off'), 'extglob should be off');
    });

    it('shopt -p prints in reusable format', async () => {
      const { stdout, exit } = await runShell('shopt -p\n');
      assert.strictEqual(exit, 0);
      assert.ok(stdout.includes('shopt -u extglob') || stdout.includes('shopt -s extglob'),
        'should print shopt -s/-u format');
      assert.ok(stdout.includes('shopt -u globstar') || stdout.includes('shopt -s globstar'),
        'should print globstar');
    });

    it('shopt -p name prints specific option', async () => {
      const { stdout, exit } = await runShell('shopt -s extglob\nshopt -p extglob\n');
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), 'shopt -s extglob');
    });

    it('shopt -q name returns exit code without output', async () => {
      const { stdout, exit } = await runShell('shopt -s extglob\nshopt -q extglob\n');
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout, '', 'should produce no output');
    });

    it('shopt -q returns 1 for disabled option', async () => {
      const { stdout, exit } = await runShell('shopt -q extglob\n');
      assert.strictEqual(exit, 1);
      assert.strictEqual(stdout, '', 'should produce no output');
    });

    it('shopt name shows status and exit code reflects state', async () => {
      const { stdout: out1, exit: exit1 } = await runShell('shopt extglob\n');
      assert.strictEqual(exit1, 1);
      assert.ok(out1.includes('off'));

      const { stdout: out2, exit: exit2 } = await runShell('shopt -s extglob\nshopt extglob\n');
      assert.strictEqual(exit2, 0);
      assert.ok(out2.includes('on'));
    });

    it('shopt -s invalid_option prints error to stderr and exits 2', async () => {
      const { stdout, stderr } = await runShell('shopt -s invalid_option\necho exit=$?\n');
      assert.ok(stderr.includes('invalid_option'), 'should mention the bad option name');
      assert.ok(stdout.includes('exit=2'), 'shopt with invalid option should set $? to 2');
    });

    it('shopt -s opt1 opt2 enables multiple', async () => {
      const { stdout, exit } = await runShell('shopt -s extglob globstar\nshopt extglob\nshopt globstar\n');
      assert.strictEqual(exit, 0);
      assert.ok(stdout.includes('extglob') && stdout.includes('on'));
      assert.ok(stdout.includes('globstar') && stdout.includes('on'));
    });

    it('echo $SHELLOPTS outputs colon-separated set -o options', async () => {
      const { stdout, exit } = await runShell('echo $SHELLOPTS\n');
      assert.strictEqual(exit, 0);
      const val = stdout.trim();
      assert.ok(val.length === 0 || !val.includes(' '), 'should be colon-separated, not space-separated');
    });

    it('set -e; echo $SHELLOPTS includes errexit', async () => {
      const { stdout } = await runShell('set -e\necho $SHELLOPTS\n');
      assert.ok(stdout.trim().split(':').includes('errexit'), 'should include errexit');
    });

    it('echo $BASHOPTS outputs colon-separated shopt options', async () => {
      const { stdout, exit } = await runShell('echo $BASHOPTS\n');
      assert.strictEqual(exit, 0);
      const val = stdout.trim();
      assert.ok(val.length === 0 || !val.includes(' '), 'should be colon-separated, not space-separated');
    });

    it('shopt -s extglob; echo $BASHOPTS includes extglob', async () => {
      const { stdout } = await runShell('shopt -s extglob\necho $BASHOPTS\n');
      assert.ok(stdout.trim().split(':').includes('extglob'), 'should include extglob');
    });

    it('in POSIX mode, $SHELLOPTS includes posix', async () => {
      const { stdout } = await runShell('set -o posix\necho $SHELLOPTS\n');
      assert.ok(stdout.trim().split(':').includes('posix'), 'should include posix');
    });

    it('$SHELLOPTS is sorted', async () => {
      const { stdout } = await runShell('set -e\nset -o pipefail\necho $SHELLOPTS\n');
      const opts = stdout.trim().split(':');
      const sorted = [...opts].sort();
      assert.deepStrictEqual(opts, sorted, 'SHELLOPTS should be sorted');
    });

    it('$BASHOPTS is sorted', async () => {
      const { stdout } = await runShell('shopt -s nullglob\nshopt -s extglob\necho $BASHOPTS\n');
      const opts = stdout.trim().split(':');
      const sorted = [...opts].sort();
      assert.deepStrictEqual(opts, sorted, 'BASHOPTS should be sorted');
    });
  });
}
